// Reasoning effort (推理强度) — shared vocabulary between renderer and sidecar.
//
// Issue #324: expose per-session control over the provider's reasoning-depth
// knob. One UI selector, three wire mappings:
//   - builtin + Anthropic-protocol → Claude Agent SDK `query({ effort })`
//   - builtin + OpenAI-protocol   → OpenAI bridge injects `reasoning_effort`
//     (chat_completions) / `reasoning.effort` (responses)
//   - external runtimes           → Claude Code `--effort`, Codex `turn/start.effort`
//
// 'default' = follow provider/runtime default = the pre-#324 behavior (builtin
// keeps SDK effort 'high', which the Anthropic API defines as identical to
// omitting the parameter; the OpenAI bridge omits reasoning fields entirely).
//
// Storage convention: session snapshot / agent config persist the LITERAL
// string 'default'. That keeps the `sessionMeta.x ?? agent.x` fallback chain
// able to express "this session explicitly reverted to default" even when the
// agent-level value is non-default. Absent/undefined also means default.

export const REASONING_EFFORT_DEFAULT = 'default';

/** Claude Agent SDK `EffortLevel` — also exactly the Claude Code CLI
 *  `--effort` vocabulary (verified against `claude --help`, CC 2.x). */
export const SDK_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type SdkEffortLevel = (typeof SDK_EFFORT_LEVELS)[number];

/** Union of effort values across OpenAI-compatible providers (researched
 *  2026-06: OpenAI none/minimal/low/medium/high/xhigh; Volcano Ark
 *  minimal..max; DeepSeek high/max with silent mapping). 'none' is excluded —
 *  it overlaps 'minimal' semantically and only OpenAI 5.1+ accepts it.
 *  Values are passed through verbatim; whether a given upstream accepts a
 *  given value is the provider's contract (hence the UI hint 需服务商支持). */
export const OPENAI_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Codex app-server `turn/start.effort` — model-advertised values; gpt-5.x
 *  family supports minimal..xhigh (no 'max' tier as of codex 0.136). */
export const CODEX_EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/**
 * Normalize a persisted/wire setting to the internal representation:
 * `undefined` = default (don't send anything; keep today's behavior).
 */
export function normalizeReasoningEffort(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === REASONING_EFFORT_DEFAULT) return undefined;
  return trimmed;
}

export function isSdkEffortLevel(value: string | undefined): value is SdkEffortLevel {
  return !!value && (SDK_EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * The selectable effort levels for a given surface, or `null` when the
 * surface has no reasoning-effort knob (the UI hides the row entirely).
 *
 * @param runtime     'builtin' | 'claude-code' | 'codex' | 'gemini' | ...
 * @param apiProtocol builtin only — the active provider's protocol
 *                    (undefined = Anthropic official / subscription)
 */
export function reasoningEffortChoices(
  runtime: string,
  apiProtocol?: 'anthropic' | 'openai',
): readonly string[] | null {
  switch (runtime) {
    case 'builtin':
      return apiProtocol === 'openai' ? OPENAI_EFFORT_LEVELS : SDK_EFFORT_LEVELS;
    case 'claude-code':
      return SDK_EFFORT_LEVELS;
    case 'codex':
      return CODEX_EFFORT_LEVELS;
    default:
      // Gemini (no ACP effort surface) and unknown runtimes → hidden.
      return null;
  }
}

/** Short UI annotation per level (uniform typography; see DESIGN.md 6.5). */
export const REASONING_EFFORT_DESCRIPTIONS: Record<string, string> = {
  [REASONING_EFFORT_DEFAULT]: '跟随服务商',
  minimal: '最浅',
  low: '较浅',
  medium: '均衡',
  high: '较深',
  xhigh: '深度',
  max: '最深',
};
