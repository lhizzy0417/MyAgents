import type { RuntimeType } from '../../shared/types/runtime';
import type { MessageUsage } from '../types/session';

export const EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const CODEX_LONG_CONTEXT_THRESHOLD_TOKENS = 1_000_000;
export const CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS = 30 * 60 * 1000;
export const CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS = 60 * 60 * 1000;
export const CODEX_LONG_CONTEXT_EXTRA_PER_MILLION_MS = 5 * 60 * 1000;
export const CODEX_WATCHDOG_ESTIMATED_BYTES_PER_TOKEN = 4;

export interface WatchdogContextMessage {
  content: string;
}

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

/**
 * #323 — 把「最近一次调用的 per-call usage」归一为 context 占用 token 数；没有 per-call
 * 快照（null/undefined）或占用 ≤ 0 时返回 `null`，调用方据此**跳过**广播。
 *
 * 关键不变量：占用只能来自单次调用，**绝不**回落到整 turn 聚合（`currentTurnUsage`）。
 * 聚合把每次调用的 cache-read 求和（result.modelUsage 的 `totalCacheRead += ...`），在
 * `/compact` 这种「有成功 result + 大 modelUsage、却没有携带 usage 的主轮 assistant
 * message」的控制轮里，会把 20M+ 的求和当成当前占用 → 圆环封顶 100% + 不可能的 token 数
 * （4.55M / 20.40M over 1M）。约定：调用方只传**单次调用**的 `latestMainAssistantUsage`，
 * 从不传整 turn 的 `currentTurnUsage`（两者 shape 兼容，TS 结构类型挡不住，靠 review +
 * 本函数的「缺失即 null」契约兜底）；缺失就返回 null，宁可保留上一可信值、由下一条真实消息
 * 自愈，也不显假占用。这与外部 runtime「占用只用 adapter 显式给出的 contextOccupiedTokens、
 * 缺失时不发」是同一条纪律。
 */
export function resolveContextOccupancyTokens(perCallUsage: MessageUsage | null | undefined): number | null {
  if (!perCallUsage) return null;
  const occupied = observedContextTokens(perCallUsage);
  return occupied > 0 ? occupied : null;
}

export function estimatedContextTokensFromMessages(
  messages: WatchdogContextMessage[],
  extraText = '',
): number {
  let bytes = Buffer.byteLength(extraText, 'utf8');
  for (const message of messages) {
    bytes += Buffer.byteLength(message.content, 'utf8');
  }
  return Math.ceil(bytes / CODEX_WATCHDOG_ESTIMATED_BYTES_PER_TOKEN);
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
