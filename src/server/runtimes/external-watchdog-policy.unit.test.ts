import { describe, expect, it } from 'vitest';

import type { MessageUsage } from '../types/session';
import {
  CODEX_LONG_CONTEXT_MAX_TIMEOUT_MS,
  CODEX_LONG_CONTEXT_MIN_TIMEOUT_MS,
  EXTERNAL_WATCHDOG_DEFAULT_TIMEOUT_MS,
  externalRuntimeWatchdogTimeoutMs,
  observedContextTokens,
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
