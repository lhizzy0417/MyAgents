//! Session ↔ Channel surface handover (PRD 0.2.14).
//!
//! Two Tauri commands surface here:
//!
//! * [`cmd_session_new_with_surface_migration`] — desktop user clicks "+新对话"
//!   on a channel-bound session. The channel's `peer_sessions` binding is
//!   rotated to a fresh `session_id`. Behaviour matches IM `/new`.
//!
//! * [`cmd_handover_session_to_channel`] — desktop user clicks the 📤 button on
//!   a pure-desktop session and picks a target channel. The channel's prior
//!   binding (if any) is replaced; the desktop session gains a
//!   `SidecarOwner::Agent(session_key)` so subsequent IM messages route into it.
//!
//! Heavy lifting reuses what already exists:
//!
//! * [`super::router::SessionRouter::reset_session`] handles the `/api/im/session/new`
//!   call to the sidecar plus `cmd_upgrade_session_id`.
//! * [`crate::sidecar::ensure_session_sidecar`] / [`crate::sidecar::release_session_sidecar`]
//!   manage the `SidecarOwner::Agent` lifetime.

use std::path::PathBuf;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use super::router::parse_session_key;
use super::types::PeerSession;
use super::ManagedAgents;
use crate::sidecar::{
    ensure_session_sidecar, release_session_sidecar, ManagedSidecarManager, SidecarOwner,
};
use crate::{ulog_info, ulog_warn};

/// UTF-8-safe shortener for log lines and notification text. The bare
/// `&s[..8.min(s.len())]` form is byte-indexed and panics if byte 8 lands
/// inside a multi-byte char. Session ids are UUIDs so the panic never
/// triggers in practice, but the chars-based form is correct by construction
/// and removes the trap for any future caller passing non-ASCII strings.
fn short_id(s: &str) -> String {
    s.chars().take(8).collect()
}

// ============================================================================
// 1. New conversation with surface migration
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionResult {
    pub new_session_id: String,
}

/// Desktop "+新对话" on a channel-bound session.
///
/// Looks up the agent that owns `session_key`, calls
/// `router.reset_session(session_key, …)` which:
///
///   1. Hits `/api/im/session/new` on the sidecar to mint a fresh `sessionId`
///   2. Calls `manager.upgrade_session_id(old, new)` so the sidecar keeps
///      running but is now keyed under the new id
///   3. Updates `peer_sessions[session_key].session_id = new`
///
/// The returned `newSessionId` is what the desktop tab should adopt.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_session_new_with_surface_migration<R: Runtime>(
    app: AppHandle<R>,
    oldSessionId: String,
    sessionKey: String,
) -> Result<NewSessionResult, String> {
    ulog_info!(
        "[handover] surface migration: session={} key={}",
        short_id(&oldSessionId),
        sessionKey,
    );

    let agent_state: tauri::State<'_, ManagedAgents> = app
        .try_state()
        .ok_or_else(|| "Agent state unavailable".to_string())?;
    let manager: tauri::State<'_, ManagedSidecarManager> = app
        .try_state()
        .ok_or_else(|| "Sidecar manager unavailable".to_string())?;

    // Locate the channel that owns this session_key. We scan ManagedAgents
    // because session_key encodes agent_id but ChannelInstance routers don't
    // expose a reverse index.
    let parts: Vec<&str> = sessionKey.split(':').collect();
    if parts.len() < 5 || parts[0] != "agent" {
        return Err(format!("Invalid session_key format: {}", sessionKey));
    }
    let target_agent_id = parts[1];

    let router_arc = {
        let agents = agent_state.lock().await;
        let agent = agents.get(target_agent_id).ok_or_else(|| {
            format!(
                "Agent {} not found (channel may be offline)",
                target_agent_id
            )
        })?;

        // The router sits on each ChannelInstance.bot_instance. Find the
        // channel whose router actually has this peer_session entry. The
        // common case is a single-channel agent so the loop is cheap.
        let mut found = None;
        for ch in agent.channels.values() {
            let router_guard = ch.bot_instance.router.lock().await;
            if router_guard.has_peer_session(&sessionKey) {
                drop(router_guard);
                found = Some(ch.bot_instance.router.clone());
                break;
            }
        }
        found
    };

    let router_arc = router_arc.ok_or_else(|| {
        format!(
            "No active channel binds session_key {}; cannot migrate",
            sessionKey
        )
    })?;

    let new_session_id = {
        let mut router = router_arc.lock().await;
        router
            .reset_session(&sessionKey, &app, manager.inner())
            .await?
    };

    ulog_info!(
        "[handover] surface migration done: {} → {}",
        short_id(&oldSessionId),
        short_id(&new_session_id),
    );

    Ok(NewSessionResult { new_session_id })
}

// ============================================================================
// 2. Handover desktop session to channel
// ============================================================================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoverResult {
    pub ok: bool,
    pub session_key: String,
    pub notified: bool,
}

/// Bind `session_id` (the desktop session) to `(agent_id, channel_id)`.
///
/// We replace the channel's most-recently-active `peer_session` so the channel
/// continues talking to the same chat (same user / same group), just with the
/// desktop session as the new conversation backend. The old binding's session
/// loses its `Agent` owner; the desktop session gains it.
///
/// ## Step ordering (v0.2.14 cross-bugfix)
///
/// Earlier ordering wrote the `peer_session` mutation BEFORE attaching the
/// `Agent` owner to the target sidecar. If `ensure_session_sidecar` failed
/// (or panicked silently), the channel would already be bound to the new
/// session_id but the desktop tab would be the only owner — close the tab
/// and the sidecar dies, IM messages then orphan into nothing.
///
/// New order:
///
///   1. Resolve channel + workspace (read-only)
///   2. Snapshot the chat to take over (`most_recent_peer_session_key`)
///   3. Look up sidecar port (read-only)
///   4. **`ensure_session_sidecar`** — attach Agent owner FIRST. Fail-fast
///      here makes the operation atomic from the user's POV: nothing was
///      mutated, the old binding is intact, the renderer toast says
///      "交接失败" with no surprise side-effects.
///   5. **Mutate `peer_sessions`** — atomic snapshot+upsert under one lock.
///   6. Release prior owner (best-effort).
///   7. Send notification to the IM chat (last step; failure → notified=false
///      surfaces back to the renderer toast as "已交接（通知未发送）").
///
/// ## Observability
///
/// Every step logs an `[handover]` ulog line on entry / decision / completion.
/// The PRD 0.2.14 dogfood found a case where the function silently exited
/// after acquiring the manager lock with NO subsequent log line, which made
/// root-causing the missing notification impossible. Each step is now a
/// log breadcrumb so partial-failure diagnosis is grep-able.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn cmd_handover_session_to_channel<R: Runtime>(
    app: AppHandle<R>,
    sessionId: String,
    agentId: String,
    channelId: String,
    workspacePath: String,
) -> Result<HandoverResult, String> {
    ulog_info!(
        "[handover] start session={} → agent={} channel={}",
        short_id(&sessionId),
        agentId,
        channelId,
    );

    let agent_state: tauri::State<'_, ManagedAgents> = app
        .try_state()
        .ok_or_else(|| {
            ulog_warn!("[handover] step1 ManagedAgents state unavailable");
            "Agent state unavailable".to_string()
        })?;
    let manager: tauri::State<'_, ManagedSidecarManager> = app
        .try_state()
        .ok_or_else(|| {
            ulog_warn!("[handover] step1 ManagedSidecarManager state unavailable");
            "Sidecar manager unavailable".to_string()
        })?;

    // ----- 1. Resolve target channel + workspace constraint
    let (router_arc, adapter, agent_workspace) = {
        let agents = agent_state.lock().await;
        let agent = agents.get(&agentId).ok_or_else(|| {
            ulog_warn!(
                "[handover] step1 agent {} not found in ManagedAgents",
                agentId
            );
            format!("Agent {} not found", agentId)
        })?;
        let channel = agent.channels.get(&channelId).ok_or_else(|| {
            ulog_warn!(
                "[handover] step1 channel {} not found in agent {}",
                channelId,
                agentId
            );
            format!("Channel {} not found in agent {}", channelId, agentId)
        })?;
        (
            channel.bot_instance.router.clone(),
            channel.bot_instance.adapter.clone(),
            agent.config.workspace_path.clone(),
        )
    };
    ulog_info!("[handover] step1 channel resolved");

    let req_workspace = PathBuf::from(&workspacePath);
    if normalize_str(&agent_workspace) != normalize_path(&req_workspace) {
        ulog_warn!(
            "[handover] workspace mismatch: agent={} request={}",
            agent_workspace,
            req_workspace.display()
        );
        return Err(format!(
            "Workspace mismatch: agent workspace = {}, session workspace = {}",
            agent_workspace,
            req_workspace.display(),
        ));
    }

    // ----- 2. Pick the chat to take over (most-recently-active peer_session
    // in this channel). v1 requires at least one prior chat exists so we
    // know which chat_id to bind to.
    let target_session_key = {
        let router = router_arc.lock().await;
        router.most_recent_peer_session_key().ok_or_else(|| {
            ulog_warn!("[handover] no prior peer_session for channel {}", channelId);
            "Channel 没有最近活跃的对话；请先在 IM 端发一条消息建立会话".to_string()
        })?
    };
    ulog_info!("[handover] step2 target_session_key={}", target_session_key);

    // ----- 3. Sanity-check that the target session HAS a Sidecar in the
    // manager. We don't reuse this port directly — `ensure_session_sidecar`
    // below returns the authoritative port (it may replace a dead sidecar
    // and mint a new one). Reading the pre-ensure port and writing it into
    // peer_sessions would bind IM to a stale port if a replacement happened
    // (review-by-codex F1 finding).
    {
        let mgr = manager.lock().map_err(|e| {
            ulog_warn!("[handover] step3 manager lock poisoned: {}", e);
            e.to_string()
        })?;
        if mgr.get_session_port(&sessionId).is_none() {
            ulog_warn!(
                "[handover] step3 session {} has no Sidecar in manager",
                short_id(&sessionId)
            );
            return Err(format!(
                "Session {} has no running Sidecar — open the tab first",
                short_id(&sessionId)
            ));
        }
    }
    ulog_info!(
        "[handover] step3 session {} sidecar present",
        short_id(&sessionId),
    );

    // ----- 4. Attach Agent owner to target Sidecar FIRST (fail-fast).
    //
    // Done before any router mutation so that an `ensure_session_sidecar`
    // failure leaves zero observable side-effect — the old binding is intact,
    // no orphaned chat-id-without-owner state. Was step 5 in the pre-0.2.14
    // ordering; reordered after a dogfood report where the function exited
    // silently mid-step without notification or `[handover] done` log.
    //
    // CRITICAL: `ensure_session_sidecar` is documented as a BLOCKING function
    // (uses `reqwest::blocking::Client` + `std::sync::Mutex`). Calling it
    // directly from this async Tauri command would deadlock the runtime —
    // which is exactly what the dogfood log showed (function entered, lock
    // acquired, then no further log). Wrap in `tokio::task::spawn_blocking`
    // per the contract documented at `sidecar.rs::ensure_session_sidecar`.
    // (review-by-codex F2 finding — root cause of v0.2.14 dogfood Bug 1).
    let owner = SidecarOwner::Agent(target_session_key.clone());
    let app_clone = app.clone();
    let mgr_clone = manager.inner().clone();
    let sid_clone = sessionId.clone();
    let workspace_clone = req_workspace.clone();
    let owner_clone = owner.clone();
    let ensure_result = tokio::task::spawn_blocking(move || {
        ensure_session_sidecar(
            &app_clone,
            &mgr_clone,
            &sid_clone,
            &workspace_clone,
            owner_clone,
        )
    })
    .await
    .map_err(|e| {
        ulog_warn!("[handover] step4 spawn_blocking join error: {}", e);
        format!("ensure_session_sidecar join failed: {}", e)
    })?
    .map_err(|e| {
        ulog_warn!(
            "[handover] step4 ensure_session_sidecar failed for session {}: {}",
            short_id(&sessionId),
            e
        );
        format!("Failed to attach Agent owner: {}", e)
    })?;
    let target_port = ensure_result.port;
    ulog_info!(
        "[handover] step4 Agent owner attached to session {} (port={}, is_new={})",
        short_id(&sessionId),
        target_port,
        ensure_result.is_new,
    );

    // ----- 5. Mutate router atomically (snapshot prior + upsert under one lock).
    //
    // Use `target_port` from step 4 (the authoritative port returned by
    // ensure_session_sidecar) rather than what step 3 read pre-ensure —
    // `is_new=true` means the old sidecar was dead and a fresh one was minted
    // on a different port; binding the IM channel to the stale port would
    // route subsequent messages into a closed socket.
    let (chat_id, prior_session_id) = {
        let mut router = router_arc.lock().await;
        let prior = router.peer_session_snapshot(&target_session_key);
        let prior_session_id = prior.as_ref().map(|p| p.session_id.clone());
        let (source_type, source_id) = parse_session_key(&target_session_key);

        router.upsert_peer_session(PeerSession {
            session_key: target_session_key.clone(),
            session_id: sessionId.clone(),
            sidecar_port: target_port,
            workspace_path: req_workspace.clone(),
            source_type,
            source_id: source_id.clone(),
            message_count: 0,
            last_active: Instant::now(),
        });

        (source_id, prior_session_id)
    };
    ulog_info!(
        "[handover] step5 peer_session upserted: chat_id={} prior_session={}",
        chat_id,
        prior_session_id.as_deref().map(short_id).unwrap_or_else(|| "none".into()),
    );

    // ----- 6. Release the prior session's Agent owner (best-effort).
    // Same-session re-bind (prior == new) is a no-op — don't accidentally
    // strip the owner we just attached.
    if let Some(prior_sid) = prior_session_id.as_deref() {
        if prior_sid != sessionId {
            match release_session_sidecar(manager.inner(), prior_sid, &owner) {
                Ok(stopped) => ulog_info!(
                    "[handover] step6 released prior Agent owner from {} (sidecar_stopped={})",
                    short_id(prior_sid),
                    stopped
                ),
                Err(e) => ulog_warn!(
                    "[handover] step6 release_session_sidecar({}) failed: {}",
                    short_id(prior_sid),
                    e
                ),
            }
        }
    }

    // ----- 7. Notify the channel. Same 8-char session-id prefix surface that
    // `/new` shows in IM (`✅ 已创建新对话 (xxxxxxxx)`) so the user can
    // correlate the two affordances. Failure here is non-fatal — `notified`
    // surfaces back to the renderer toast.
    let notification = format!("当前会话切换至「{}」", short_id(&sessionId));
    ulog_info!(
        "[handover] step7 sending notification to chat={} via adapter",
        chat_id
    );
    let notified = match adapter.send_message(&chat_id, &notification).await {
        Ok(_) => {
            ulog_info!("[handover] step7 notification sent");
            true
        }
        Err(e) => {
            ulog_warn!("[handover] step7 notification send failed: {}", e);
            false
        }
    };

    ulog_info!(
        "[handover] done: session={} now bound to {} (notified={})",
        short_id(&sessionId),
        target_session_key,
        notified,
    );

    Ok(HandoverResult {
        ok: true,
        session_key: target_session_key,
        notified,
    })
}

fn normalize_path(p: &std::path::Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn normalize_str(s: &str) -> String {
    s.replace('\\', "/")
}

// AnyAdapter::send_message is on `ImAdapter` — pull the trait into scope so
// `adapter.send_message(...)` resolves on `Arc<AnyAdapter>` in §6 above.
use super::adapter::ImAdapter;
