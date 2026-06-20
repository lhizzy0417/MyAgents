use super::*;

// ─── Agent Runtime resolution (v0.1.59) ───

// BOM-stripping moved to crate::utils::bom (issue #170 #6) so all JSON-
// reading sites share a single helper.
use crate::utils::bom::strip_bom;

/// Look up the `runtime` field from the agent config in ~/.myagents/config.json
/// matching the given workspace path. Returns None for "builtin" (the default).
/// Used for NEW sessions (the agent config decides the default runtime for new conversations)
/// and for IM/Agent sidecar paths that don't have a session_id yet.
pub(super) fn resolve_agent_runtime_from_config(
    workspace_path: &std::path::Path,
) -> Option<String> {
    let config_path = dirs::home_dir()?.join(".myagents").join("config.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let cfg: serde_json::Value = serde_json::from_str(strip_bom(&content)).ok()?;

    // Gate: multi-agent runtime feature must be explicitly enabled (developer mode)
    // When off, all sidecars start as builtin regardless of agent config
    if !cfg
        .get("multiAgentRuntime")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }

    let workspace_str = workspace_path.to_string_lossy();
    let agents = cfg.get("agents")?.as_array()?;
    for agent in agents {
        let agent_path = agent.get("workspacePath")?.as_str()?;
        if agent_path == workspace_str.as_ref() {
            if let Some(runtime) = agent.get("runtime").and_then(|v| v.as_str()) {
                if runtime != "builtin" {
                    return Some(runtime.to_string());
                }
            }
            return None;
        }
    }
    None
}

/// Look up the `runtime` field from session metadata in ~/.myagents/sessions.json.
/// Returns Some("builtin") for builtin/missing-runtime sessions that are found,
/// and None only when no authoritative session metadata is available.
///
/// This is the authoritative source for EXISTING sessions — the session's own metadata
/// records which runtime created it, regardless of the current agent config.
/// Agent config (resolve_agent_runtime_from_config) decides the default for NEW sessions
/// and is gated by `multiAgentRuntime`; session metadata is stable once created and is
/// read regardless of that gate so an existing runtime-A history is never reopened as
/// runtime B under the same MyAgents session_id.
pub fn resolve_session_runtime_identity(session_id: &str) -> Option<String> {
    let sessions_path = dirs::home_dir()?.join(".myagents").join("sessions.json");
    let content = std::fs::read_to_string(&sessions_path).ok()?;
    resolve_session_runtime_identity_from_json(session_id, &content)
}

pub(super) fn resolve_session_runtime_identity_from_json(
    session_id: &str,
    content: &str,
) -> Option<String> {
    let sessions: serde_json::Value = serde_json::from_str(strip_bom(content)).ok()?;
    let sessions_arr = sessions.as_array()?;

    for session in sessions_arr {
        if session.get("id").and_then(|v| v.as_str()) == Some(session_id) {
            return Some(
                normalize_runtime_name(session.get("runtime").and_then(|v| v.as_str())).to_string(),
            );
        }
    }
    None
}

pub(super) fn resolve_session_runtime(session_id: &str) -> Option<String> {
    resolve_session_runtime_identity(session_id).filter(|runtime| runtime != "builtin")
}

/// Lazy validation for tab restore (Issue #232 / PRD 0.2.25).
///
/// A restored "cold" chat tab is only activatable if (a) its session still
/// exists in `~/.myagents/sessions.json` and (b) its workspace directory still
/// exists on disk. This is read-only and reads the disk directly — it does NOT
/// depend on the global sidecar being up (which is async + flaky on startup),
/// matching the PRD's "validate lazily at first activation, decoupled from
/// global sidecar readiness" decision.
///
/// Returns false (drop the tab) on any miss: deleted session, moved/deleted
/// workspace, or unreadable index.
#[tauri::command]
#[allow(non_snake_case)]
pub fn cmd_can_restore_session(sessionId: String, agentDir: String) -> bool {
    // Validate the workspace through the project's canonical chokepoint
    // (system blacklist + must be an existing directory), same as every other
    // workspace command — NOT a bare `is_dir()`, which would accept relative /
    // credential / system paths. Catches moved/deleted workspaces that would
    // otherwise become a cold-start sidecar-spawn failure on click.
    if crate::workspace_files::path_safety::validate_workspace_root(&agentDir).is_err() {
        return false;
    }
    let Some(sessions_path) = dirs::home_dir().map(|h| h.join(".myagents").join("sessions.json"))
    else {
        return false;
    };
    let Ok(content) = std::fs::read_to_string(&sessions_path) else {
        return false;
    };
    let Ok(sessions) = serde_json::from_str::<serde_json::Value>(strip_bom(&content)) else {
        return false;
    };
    let Some(arr) = sessions.as_array() else {
        return false;
    };
    // The session must exist AND belong to this workspace. Cross-checking
    // agentDir prevents a corrupted/stale localStorage entry from restoring
    // session A under workspace B (which would apply the wrong workspace / MCP /
    // model config to an existing conversation). Both agentDir values originate
    // from the same launch path (persisted tab vs session metadata), so a raw
    // string compare is correct.
    arr.iter().any(|s| {
        s.get("id").and_then(|v| v.as_str()) == Some(&sessionId)
            && s.get("agentDir").and_then(|v| v.as_str()) == Some(&agentDir)
    })
}

/// v0.1.69 T13: Runtime invariant check on Sidecar reuse.
///
/// Under the v0.1.69 layered-snapshot model, a session's `runtime` is part of
/// its immutable identity (stamped at creation in sessions.json). The Sidecar
/// was spawned with MYAGENTS_RUNTIME derived from the owner-aware priority
/// chain. These two MUST stay aligned for the lifetime of the Sidecar — a
/// cross-runtime session switch opens a new Tab (Scenario 1.5 / T12), it
/// doesn't swap the runtime under a live Sidecar.
///
/// If we detect a mismatch on a reuse path, it indicates either:
///   (a) T12's new-tab gate missed a case
///   (b) Session metadata was mutated post-creation (shouldn't happen)
///   (c) Two sessions with different runtimes ended up sharing a sidecar entry
///
/// We log loudly with `[sidecar][runtime-drift-on-reuse]` so the bug surfaces
/// in `grep` of unified logs, but do NOT kill the sidecar. Killing here could
/// orphan shared desktop owners whose SSE streams depend on it — the
/// invariant violation is worth investigating, not worth amplifying into a
/// user-visible regression. The IM-router drift check at
/// `kill_sidecar_if_runtime_differs` is still the correct place to kill, and
/// only fires when all owners are Agent-type.
pub(super) fn validate_sidecar_runtime_invariant(
    session_id: &str,
    sidecar_runtime: Option<&str>,
    site: &str,
) {
    let sidecar_rt = sidecar_runtime.unwrap_or("builtin");
    let session_rt = resolve_session_runtime(session_id);
    let session_rt_str = session_rt.as_deref().unwrap_or("builtin");
    if sidecar_rt != session_rt_str {
        ulog_error!(
            "[sidecar][runtime-drift-on-reuse] session={} site={} sidecar_runtime={} session_runtime={} — T12 gate may have missed a case; not killing to avoid orphaning shared owners",
            session_id, site, sidecar_rt, session_rt_str
        );
    }
}
