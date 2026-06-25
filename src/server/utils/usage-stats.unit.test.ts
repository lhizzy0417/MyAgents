import { describe, expect, it } from 'vitest';

import { addMessageUsageToByModel, type UsageByModel } from './usage-stats';

describe('usage stats provider-qualified model aggregation', () => {
  it('keeps the same model id separate for different providers', () => {
    const byModel: UsageByModel = {};

    addMessageUsageToByModel(byModel, {
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        model: 'deepseek-v4-flash',
      },
    }, 'deepseek');
    addMessageUsageToByModel(byModel, {
      usage: {
        inputTokens: 20,
        outputTokens: 4,
        model: 'deepseek-v4-flash',
      },
    }, 'sensenova');

    expect(Object.values(byModel)).toEqual([
      expect.objectContaining({
        providerId: 'deepseek',
        model: 'deepseek-v4-flash',
        inputTokens: 10,
        outputTokens: 2,
        count: 1,
      }),
      expect.objectContaining({
        providerId: 'sensenova',
        model: 'deepseek-v4-flash',
        inputTokens: 20,
        outputTokens: 4,
        count: 1,
      }),
    ]);
  });

  it('prefers per-message provider identity over session fallback', () => {
    const byModel: UsageByModel = {};

    addMessageUsageToByModel(byModel, {
      usage: {
        inputTokens: 8,
        outputTokens: 1,
        providerId: 'turn-provider',
        modelUsage: {
          'deepseek-v4-flash': {
            inputTokens: 8,
            outputTokens: 1,
          },
        },
      },
    }, 'session-provider');

    expect(Object.values(byModel)).toEqual([
      expect.objectContaining({
        providerId: 'turn-provider',
        model: 'deepseek-v4-flash',
        inputTokens: 8,
        outputTokens: 1,
        count: 1,
      }),
    ]);
  });
});
