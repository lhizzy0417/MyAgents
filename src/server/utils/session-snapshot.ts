import type { AgentConfig } from '../../shared/types/agent';
import {
  buildRuntimeChangePatch,
  coerceModelForRuntime,
  coercePermissionModeForRuntime,
  type RuntimeType,
} from '../../shared/types/runtime';
import { coerceReasoningEffortSettingForRuntime } from '../../shared/reasoningEffort';
import type { SessionMetadata } from '../types/session';

/**
 * Session config snapshot helpers (v0.1.69).
 *
 * Two independent helpers for two owner policies. **Do not** collapse them
 * into an enum-dispatched single function — the split is intentional
 * pit-of-success: each call site self-documents which snapshot policy it
 * wants, and a compile error is the only thing that can silently change
 * behavior when a new field is added.
 *
 * Callers feed the returned `Partial<SessionMetadata>` to
 * `createSessionMetadata(agentDir, snapshot)`. Hand-assembling snapshot
 * fields outside these helpers is forbidden (see PRD §6.2 Pit-of-success).
 */

/**
 * Payload set captured by the "owned session" snapshot policy. Single
 * source of truth for "what to copy from agent config into a session
 * being frozen". Referenced by:
 *   - `snapshotForOwnedSession()` below (desktop/Cron creation path)
 *   - `/api/session/freeze` endpoint (v0.2.14+ runtime-change detach)
 *   - Rust `OwnedSessionSnapshot` in `src-tauri/src/im/runtime_change.rs`
 *     (v0.2.14+ — must keep field set in lock-step with this type)
 *
 * `configSnapshotAt` is INTENTIONALLY EXCLUDED from this Pick — it's the
 * "this session is frozen" marker, stamped by the writer (sidecar
 * `/api/session/freeze` and Rust file-lock fallback) at write time, not
 * passed through the snapshot payload. Mixing it into the payload caused
 * TS↔Rust drift in the v0.2.14 first-cut review. (review-by-codex F2.)
 *
 * `enabledPluginIds` is optional and currently only Node/desktop paths can
 * populate it; Rust IM freeze does not track Claude cc-plugin state and may
 * omit it. Omission means "freeze with no session plugin override", never
 * "fall back to Agent" once `configSnapshotAt` exists.
 */
export type OwnedSessionSnapshot = Pick<
  SessionMetadata,
  | 'runtime'
  | 'model'
  | 'reasoningEffort'
  | 'permissionMode'
  | 'mcpEnabledServers'
  | 'enabledPluginIds'
  | 'providerId'
  | 'providerEnvJson'
>;
// #324 — `reasoningEffort` is a DOCUMENTED divergence from the Rust mirror
// (`runtime_change.rs::OwnedSessionSnapshot` does NOT carry it): Rust never
// tracks effort state (it is deliberately not part of sync_ai_config, same
// one-direction design as #327), so the runtime-change freeze path cannot
// supply it. That is safe: the freeze endpoint skips absent fields (never
// clears), and a live-follow session being frozen falls back to
// `agent.reasoningEffort`, which survives a runtime change un-scrubbed —
// the resolved value is identical. Desktop/cron creation (this file) is the
// path that must capture it, and does.

/**
 * IM (Agent channel) owner — live-follow policy (D4).
 *
 * IM sessions deliberately do NOT snapshot model/permission/mcp; each message
 * re-resolves `agent + channel.overrides` live so the Telegram/Feishu/etc. peer
 * tracks the Agent's current config. Only `runtime` is recorded, because runtime
 * drift triggers session fork at the Router layer (sidecar.rs + router.rs) and
 * needs a stable reference.
 *
 * `runtimeSessionId` is left absent — it is filled in by the runtime on first
 * `session/new` / thread creation.
 */
interface SessionSnapshotRuntimeOptions {
  /**
   * Runtime the session is being materialized for. Used when a caller creates a
   * session as part of a runtime switch before the AgentConfig patch is written.
   */
  runtimeOverride?: RuntimeType;
}

function agentForSnapshotRuntime(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): AgentConfig {
  const currentRuntime = agent.runtime ?? 'builtin';
  const targetRuntime = options?.runtimeOverride ?? currentRuntime;
  if (targetRuntime === currentRuntime) return agent;

  const runtimePatch = buildRuntimeChangePatch(agent.runtimeConfig, targetRuntime);
  return {
    ...agent,
    runtime: runtimePatch.runtime,
    runtimeConfig: runtimePatch.runtimeConfig,
  };
}

export function snapshotForImSession(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): Partial<SessionMetadata> {
  const snapshotAgent = agentForSnapshotRuntime(agent, options);
  return {
    runtime: snapshotAgent.runtime ?? 'builtin',
  };
}

/**
 * Desktop Tab / Cron owner — full-snapshot policy (D2, D3, D9).
 *
 * Desktop sessions own their config: once created, the session is self-contained
 * and is not affected by later changes to AgentConfig (D1). Cron `new_task`
 * tick creates a fresh snapshot each run (every tick reads current Agent);
 * Cron `current_session` freezes at first creation and reuses forever.
 *
 * Return shape = `OwnedSessionSnapshot` payload + the writer-stamped
 * `configSnapshotAt` marker. For the desktop-creation path, "writer" =
 * this function (we stamp `now` here). For the runtime-change freeze path,
 * the writers (`/api/session/freeze` endpoint and Rust file-lock fallback)
 * stamp `configSnapshotAt` themselves so the marker reflects when the
 * write actually committed — those callers should pass `OwnedSessionSnapshot`
 * by itself, not the return of this function.
 *
 * **Runtime-aware model/permission capture (issue #224).** `SessionMetadata.model`
 * is overloaded — for builtin runtime it holds the SDK / provider model
 * (`agent.model`), for external runtimes it holds the CLI's model id
 * (`agent.runtimeConfig.model`). The interactive write path in
 * `renderer/api/persistInputOption.ts::buildSnapshotPatch` already encodes
 * this dispatch. Snapshot creation must match: previously this helper
 * blindly captured `agent.model` even for external runtimes, leaking a
 * Claude/builtin model name into a Codex/Gemini session snapshot. The cron
 * `followAgent` resolution path then promoted that into
 * `runtimeConfig.model`, which Codex CLI rejects (issue #224).
 */
export function snapshotForOwnedSession(
  agent: AgentConfig,
  options?: SessionSnapshotRuntimeOptions,
): OwnedSessionSnapshot & Pick<SessionMetadata, 'configSnapshotAt'> {
  const snapshotAgent = agentForSnapshotRuntime(agent, options);
  const runtime = snapshotAgent.runtime ?? 'builtin';
  const isExternal = runtime !== 'builtin';
  return {
    runtime,
    model: isExternal
      ? coerceModelForRuntime(snapshotAgent.runtimeConfig?.model, runtime)
      : snapshotAgent.model,
    // #324 — same runtime-aware dispatch as model (issue #224 rationale).
    reasoningEffort: isExternal
      ? coerceReasoningEffortSettingForRuntime(snapshotAgent.runtimeConfig?.reasoningEffort, runtime)
      : snapshotAgent.reasoningEffort,
    permissionMode: isExternal
      ? coercePermissionModeForRuntime(snapshotAgent.runtimeConfig?.permissionMode, runtime)
      : snapshotAgent.permissionMode,
    mcpEnabledServers: snapshotAgent.mcpEnabledServers ? [...snapshotAgent.mcpEnabledServers] : undefined,
    enabledPluginIds: snapshotAgent.enabledPluginIds ? [...snapshotAgent.enabledPluginIds] : undefined,
    providerId: snapshotAgent.providerId,
    providerEnvJson: snapshotAgent.providerEnvJson,
    configSnapshotAt: new Date().toISOString(),
  };
}
