// AgentRuntime abstraction types (v0.1.59)
// Defines the interface that all runtime implementations must satisfy

import type { RuntimeType, RuntimeModelInfo, RuntimePermissionMode, RuntimeDetection, RuntimeDiagnostics, RuntimeEnvPolicy } from '../../shared/types/runtime';
import type { InteractionScenario } from '../system-prompt';
import type { ModelUsageEntry } from '../types/session';
import type { ToolAttachment } from '../../shared/types/tool-attachment';
import type { LargeValueRef } from '../utils/large-value-store';

/**
 * Image payload from frontend (base64-encoded)
 */
export interface ImagePayload {
  name: string;
  mimeType: string;
  data: string;  // base64 without data URL prefix
}

/**
 * Options for starting a runtime session
 */
export interface SessionStartOptions {
  sessionId: string;
  workspacePath: string;
  initialMessage?: string;
  initialImages?: ImagePayload[];
  systemPromptAppend?: string;
  model?: string;
  permissionMode?: string;
  /** #324 — NORMALIZED reasoning effort level (never 'default'); absent =
   *  runtime default. CC maps to `--effort`, Codex to `turn/start.effort`. */
  reasoningEffort?: string;
  maxTurns?: number;
  resumeSessionId?: string;
  disallowedTools?: string[];
  scenario: InteractionScenario;
  additionalArgs?: string[];
  /**
   * Per-session env policy (issue #194). Resolved by the caller from
   * `agent.runtimeConfig.envPolicy`. When omitted, runtime adapters default
   * to `{ proxy: 'myagents' }` — the legacy MyAgents-overrides-everything
   * behaviour, preserving backwards compat.
   */
  envPolicy?: RuntimeEnvPolicy;
}

/**
 * A handle to a running runtime subprocess
 */
export interface RuntimeProcess {
  readonly pid: number;
  /** Write a line to the process stdin */
  writeLine(line: string): Promise<void>;
  /** Kill the process */
  kill(signal?: number): void;
  /** Whether the process has exited */
  exited: boolean;
  /** Wait for the process to exit */
  waitForExit(): Promise<number>;
}

/**
 * Sub-agent scope for a tool event. Set ONLY by runtimes whose protocol exposes
 * multi-agent / multi-thread tool activity within a single session (currently
 * Codex collab-agent: a spawned worker is a separate Codex thread). When present,
 * the session layer nests the tool under the parent card identified by
 * `parentToolUseId` (mirroring builtin's `parent_tool_use_id` → `subagentCalls`
 * path) instead of rendering it flat in the main transcript.
 *
 * builtin (Claude Agent SDK) does NOT use this — it has its own native
 * `parent_tool_use_id` stream path in agent-session.ts. Gemini / Claude Code
 * never set it, so their behaviour is unchanged.
 *
 * `parentToolUseId` is the toolUseId of the card that REPRESENTS the sub-agent
 * (for Codex: the `spawnAgent` collabAgentToolCall item id), already resolved by
 * the runtime to the TOP-LEVEL spawn card so the session layer stays
 * thread-agnostic.
 */
export interface SubAgentScope {
  parentToolUseId: string;
  /** Human-readable nickname assigned by the runtime to the spawned agent (optional). */
  nickname?: string;
  /** Role label assigned by the runtime to the spawned agent (optional). */
  role?: string;
}

/**
 * Unified event emitted by any runtime, consumed by the session layer.
 * The session layer maps these to SSE broadcast calls.
 */
export type UnifiedEvent =
  // === Text streaming ===
  | { kind: 'text_delta'; text: string; traceId?: string; subAgent?: SubAgentScope }
  | { kind: 'text_stop'; traceId?: string; subAgent?: SubAgentScope }

  // === Thinking/reasoning streaming ===
  | { kind: 'thinking_start'; index: number; traceId?: string; subAgent?: SubAgentScope }
  | { kind: 'thinking_delta'; text: string; index: number; traceId?: string; subAgent?: SubAgentScope }
  | { kind: 'thinking_stop'; index: number; traceId?: string; subAgent?: SubAgentScope }

  // === Tool use ===
  // `subAgent` (optional, Codex-only today): when set, the session layer nests
  // this tool under the parent spawn card instead of rendering it flat. See
  // SubAgentScope. Absent for builtin / Gemini / Claude Code.
  | { kind: 'tool_use_start'; toolUseId: string; toolName: string; input?: Record<string, unknown>; subAgent?: SubAgentScope }
  | { kind: 'tool_input_delta'; toolUseId: string; delta: string; subAgent?: SubAgentScope }
  | { kind: 'tool_use_stop'; toolUseId: string; subAgent?: SubAgentScope }
  | { kind: 'tool_result_delta'; toolUseId: string; delta: string; subAgent?: SubAgentScope }
  | {
    kind: 'tool_result';
    toolUseId: string;
    content: string;
    subAgent?: SubAgentScope;
    /**
     * Rich-media attachments (image/audio/pdf/file). Each entry references a
     * file already persisted by the sidecar (or a placeholder pending async
     * save — see ToolAttachment.pendingId). Frontend renders via
     * ToolAttachmentGallery; tool_result.content remains the human/AI-readable
     * text summary.
     */
    attachments?: ToolAttachment[];
    isError?: boolean;
    metadata?: {
      exitCode?: number | null;
      durationMs?: number | null;
      cwd?: string;
      processId?: string | null;
      status?: string;
      largeValueRef?: LargeValueRef;
    };
  }
  /**
   * Async placeholder fulfillment (Review A4 of PRD 0.2.15). Emitted after
   * tool_result, once a deferred saveToolAttachment() resolves. The frontend
   * matches by (toolUseId, pendingId) and replaces the placeholder in-place.
   */
  | {
    kind: 'tool_attachment_update';
    toolUseId: string;
    pendingId: string;
    attachment: ToolAttachment;
  }

  // === Permission delegation ===
  | {
    kind: 'permission_request';
    requestId: string;
    toolName: string;
    toolUseId: string;
    input: Record<string, unknown>;
    /** CC's suggested permission rules for "always allow" (echoed back as updatedPermissions) */
    suggestions?: unknown[];
  }
  | {
    kind: 'interactive_request_resolved';
    requestId: string;
  }

  // === Session lifecycle ===
  | { kind: 'session_init'; sessionId: string; model: string; tools: string[] }
  | { kind: 'status_change'; state: 'idle' | 'running' | 'waiting_permission' | 'error' }
  | { kind: 'turn_complete'; result?: string; status?: string; error?: string }
  | {
    kind: 'session_complete';
    result: string;
    subtype: 'success' | 'error' | 'error_max_turns' | 'error_max_budget';
  }

  // === Metadata ===
  | {
    kind: 'usage';
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    model?: string;
    modelUsage?: Record<string, ModelUsageEntry>;
    semantics?: 'delta' | 'running_total';
    /**
     * PRD 0.2.32 — 当前 context 占用（最近一次调用 input 系 token），用于 context 用量指示器。
     * **与 `inputTokens` 分开**：`inputTokens` 可能是 running_total（Codex watchdog 依赖它），
     * 而占用必须是「最近一次」。**计算占用是 adapter 的职责**：Codex = `tokenUsage.last.inputTokens`
     * （OpenAI 系，已含 cached、不再加）；Anthropic 系（CC/Gemini）= 最近一次的 `input + cacheRead + cacheCreation`。
     * external-session 只消费 adapter 显式填的这个字段，**自己不做回退**——缺失则不发 context-usage 事件。
     */
    contextOccupiedTokens?: number;
    /** PRD 0.2.32 — runtime 自报的 context 窗口（Codex `tokenUsage.modelContextWindow`）；不报传 null/省略 → 回落 registry/200K。 */
    runtimeContextWindow?: number | null;
  }
  | { kind: 'model_update'; model: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string }

  // === Runtime diagnostics (issue #194) ===
  // External-runtime self-report (auth state, feature flags, MCP/apps the
  // runtime sees, effective env). Emitted shortly after session_init.
  // session_init's `tools: []` was the previous diagnostic surface — vestigial
  // for external runtimes; this event is the real signal.
  | { kind: 'runtime_diagnostics'; diagnostics: RuntimeDiagnostics }

  // === Message replay (for session resume) ===
  | { kind: 'message_replay'; message: { id: string; role: string; content: unknown; timestamp?: string } }

  // === Passthrough for unrecognized events ===
  | { kind: 'raw'; data: unknown };

/**
 * Callback for unified events from the runtime
 */
export type UnifiedEventCallback = (event: UnifiedEvent) => void;

/**
 * AgentRuntime interface — one implementation per CLI type
 */
export interface AgentRuntime {
  readonly type: RuntimeType;

  /** Check if the CLI is installed and get version info */
  detect(): Promise<RuntimeDetection>;

  /** Query available models from the CLI (may spawn a temporary process) */
  queryModels(): Promise<RuntimeModelInfo[]>;

  /** Get the permission modes supported by this runtime */
  getPermissionModes(): RuntimePermissionMode[];

  /**
   * Start a session. Events are delivered via the callback.
   * Returns a RuntimeProcess handle for sending messages and controlling the session.
   */
  startSession(
    options: SessionStartOptions,
    onEvent: UnifiedEventCallback,
  ): Promise<RuntimeProcess>;

  /** Send a follow-up user message to an active session */
  sendMessage(process: RuntimeProcess, message: string, images?: ImagePayload[]): Promise<void>;

  /** Respond to a permission request from the runtime */
  respondPermission(
    process: RuntimeProcess,
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
    /** CC: echoed permission_suggestions for 'always_allow' → updatedPermissions */
    suggestions?: unknown[],
    /** CC: override the tool's input (e.g. AskUserQuestion needs answers injected). Empty = use original. */
    updatedInput?: Record<string, unknown>,
    /**
     * PRD #131 — for CC's `behavior: 'deny'` schema this maps to the SDK
     * `interrupt` field. `true` aborts the assistant turn after the deny
     * tool_result lands (control-transfer tool semantics: AskUserQuestion
     * cancellation, ExitPlanMode rejection, …); `false` (default) only
     * denies this single tool and lets the AI choose another. Other
     * runtimes can ignore — Codex / Gemini have no equivalent knob today.
     */
    interrupt?: boolean,
  ): Promise<void>;

  /** Stop the session gracefully */
  stopSession(process: RuntimeProcess): Promise<void>;

  /**
   * Interrupt the CURRENT turn WITHOUT killing the process — the runtime emits its normal
   * turn-end event (e.g. Codex `turn/completed`) so the session goes idle and the next queued
   * message can run. Used by force-send ("立即发送") of a queued message. Optional: runtimes
   * whose protocol can't interrupt a turn without ending the session omit it (the caller then
   * falls back to draining once the turn ends on its own). Distinct from stopSession (which
   * closes stdin / tears down the process).
   */
  interruptTurn?(process: RuntimeProcess): Promise<void>;

  /**
   * Switch the session's active model in-place without restarting the process.
   * Optional — only runtimes whose protocol exposes mid-session model switching
   * implement this (currently Gemini via ACP `session/set_model`). When absent
   * or the call fails, the session layer falls back to stopExternalSession()
   * so the next message resumes with the new model.
   */
  setModel?(process: RuntimeProcess, model: string): Promise<void>;

  /**
   * #324 — switch the session's reasoning effort in-place without restarting
   * the process. `effort` is a NORMALIZED level (never 'default'); undefined
   * = revert to the runtime's default. Optional — currently Codex (its
   * `turn/start.effort` param overrides "this turn and subsequent turns", so
   * the adapter just records the value on its process state). When absent,
   * the session layer falls back to stopExternalSession() so the next message
   * resumes with the new effort (Claude Code: per-turn spawn rereads it via
   * SessionStartOptions.reasoningEffort → `--effort`).
   */
  setReasoningEffort?(process: RuntimeProcess, effort: string | undefined): Promise<void>;
}

/**
 * Runtime rejected a `thread/resume` (Codex) or `session/load` (Gemini) because
 * the persisted runtime-side session no longer exists — the rollout was GC'd,
 * the thread was archived, or the CLI upgraded across an on-disk format change.
 *
 * external-session.ts catches this specifically so it can invalidate the stale
 * pointer (module state + persisted `meta.runtimeSessionId`) and retry fresh
 * without losing the user's message. See issue #105.
 */
export class StaleRuntimeSessionError extends Error {
  readonly isStaleRuntimeSession = true;
  constructor(public readonly runtimeSessionId: string, message: string) {
    super(message);
    this.name = 'StaleRuntimeSessionError';
  }
}
