import { describe, expect, it } from 'vitest';

import type { MessageUsage } from '../types/session';
import {
  CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
  CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS,
  EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  estimatedContextTokensFromMessages,
  externalRuntimeWatchdogTimeoutMs,
  observedContextTokens,
  resolveContextOccupancyTokens,
} from './external-watchdog-policy';

describe('externalRuntimeWatchdogTimeoutMs', () => {
  it('keeps the default timeout for non-Codex runtimes', () => {
    expect(externalRuntimeWatchdogTimeoutMs('gemini', { inputTokens: 8_000_000, outputTokens: 0 })).toBe(
      EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
    );
  });

  it('keeps the default timeout for small Codex contexts', () => {
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 999_999, outputTokens: 0 })).toBe(
      EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
    );
  });

  it('uses a larger minimum timeout for million-token Codex contexts', () => {
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS,
    );
  });

  it('scales Codex timeout with multi-million token contexts and caps it', () => {
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 6_514_414, outputTokens: 0 })).toBe(
      45 * 60 * 1000,
    );
    expect(externalRuntimeWatchdogTimeoutMs('codex', { inputTokens: 20_000_000, outputTokens: 0 })).toBe(
      CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
    );
  });
});

describe('observedContextTokens', () => {
  it('includes cache tokens and modelUsage entries', () => {
    const usage: MessageUsage = {
      inputTokens: 100,
      outputTokens: 0,
      cacheReadTokens: 200,
      cacheCreationTokens: 300,
      modelUsage: {
        'gpt-5.5': {
          inputTokens: 1_000,
          outputTokens: 0,
          cacheReadTokens: 2_000,
          cacheCreationTokens: 3_000,
        },
      },
    };

    expect(observedContextTokens(usage)).toBe(6_000);
  });
});

describe('resolveContextOccupancyTokens (#323 — /compact must not show 100% / impossible tokens)', () => {
  // The bug: broadcastBuiltinContextUsage fell back to the turn-AGGREGATE
  // (currentTurnUsage, whose cacheReadTokens is summed across every API call in
  // the turn) when no per-message assistant usage was captured. A `/compact`
  // turn is exactly that case — a successful SDK result with a large aggregate
  // modelUsage but NO main-thread assistant message.usage — so the indicator
  // showed e.g. "20.40M / 1M tokens" at a capped 100%. The fix: occupancy comes
  // ONLY from the per-call snapshot; null ⟹ skip the broadcast (never substitute
  // the aggregate). The signature structurally bars the aggregate from being
  // passed; these tests pin the skip contract.
  it('returns null for a /compact-style turn with no per-call snapshot (skip — never the aggregate)', () => {
    // What broadcastBuiltinContextUsage passes on a compact turn: latestMainAssistantUsage === null.
    // It MUST resolve to null (skip), even though currentTurnUsage held a 20.40M aggregate.
    expect(resolveContextOccupancyTokens(null)).toBeNull();
    expect(resolveContextOccupancyTokens(undefined)).toBeNull();
  });

  it('returns null when the per-call usage sums to zero (no meaningless 0% flash)', () => {
    expect(resolveContextOccupancyTokens({ inputTokens: 0, outputTokens: 0 })).toBeNull();
    expect(resolveContextOccupancyTokens({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })).toBeNull();
  });

  it('resolves a real per-call snapshot to input + cache (sane occupancy)', () => {
    const perCall: MessageUsage = {
      inputTokens: 50_000,
      outputTokens: 1_200,
      cacheReadTokens: 8_000,
      cacheCreationTokens: 2_000,
    };
    // 50_000 + 8_000 + 2_000 (output excluded — it isn't context occupancy).
    expect(resolveContextOccupancyTokens(perCall)).toBe(60_000);
  });
});

describe('estimatedContextTokensFromMessages', () => {
  it('estimates pre-usage context size from persisted message content and the new turn text', () => {
    expect(estimatedContextTokensFromMessages([
      { content: 'a'.repeat(16) },
      { content: '界'.repeat(4) },
    ], 'b'.repeat(4))).toBe(8);
  });
});
