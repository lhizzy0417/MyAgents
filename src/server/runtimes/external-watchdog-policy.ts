import type { RuntimeType } from '../../shared/types/runtime';
import type { MessageUsage } from '../types/session';

export const EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const CODEX_LONG_CONTEXT_THRESHOLD_TOKENS = 1_000_000;
export const CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS = 60 * 60 * 1000;
export const CODEX_LONG_CONTEXT_EXTRA_PER_MILLION_MS = 5 * 60 * 1000;

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function observedContextTokens(usage: MessageUsage | null | undefined): number {
  if (!usage) return 0;
  let observed = finiteNonNegative(usage.inputTokens)
    + finiteNonNegative(usage.cacheReadTokens)
    + finiteNonNegative(usage.cacheCreationTokens);

  if (usage.modelUsage) {
    for (const entry of Object.values(usage.modelUsage)) {
      observed = Math.max(
        observed,
        finiteNonNegative(entry.inputTokens)
          + finiteNonNegative(entry.cacheReadTokens)
          + finiteNonNegative(entry.cacheCreationTokens),
      );
    }
  }

  return observed;
}

export function externalRuntimeWatchdogTimeoutMs(
  runtimeType: RuntimeType,
  usage: MessageUsage | null | undefined,
): number {
  if (runtimeType !== 'codex') return EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;

  const tokens = observedContextTokens(usage);
  if (tokens < CODEX_LONG_CONTEXT_THRESHOLD_TOKENS) {
    return EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS;
  }

  const scaledTimeout = EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS
    + Math.ceil(tokens / 1_000_000) * CODEX_LONG_CONTEXT_EXTRA_PER_MILLION_MS;

  return Math.min(
    CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
    Math.max(CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS, scaledTimeout),
  );
}
