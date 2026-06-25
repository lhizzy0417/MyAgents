import type { MessageUsage, SessionMessage } from '../types/session';

export interface UsageByModelEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  count: number;
  model: string;
  providerId?: string;
}

export type UsageByModel = Record<string, UsageByModelEntry>;

function usageModelKey(model: string, providerId?: string): string {
  return providerId ? JSON.stringify([providerId, model]) : model;
}

function usageProviderId(usage: MessageUsage, fallbackProviderId?: string): string | undefined {
  const providerId = usage.providerId ?? fallbackProviderId;
  return typeof providerId === 'string' && providerId.trim() ? providerId : undefined;
}

export function addUsageToByModel(
  byModel: UsageByModel,
  model: string,
  stats: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  },
  providerId?: string,
): void {
  const key = usageModelKey(model, providerId);
  if (!byModel[key]) {
    byModel[key] = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      count: 0,
      model,
      ...(providerId ? { providerId } : {}),
    };
  }
  byModel[key].inputTokens += stats.inputTokens ?? 0;
  byModel[key].outputTokens += stats.outputTokens ?? 0;
  byModel[key].cacheReadTokens += stats.cacheReadTokens ?? 0;
  byModel[key].cacheCreationTokens += stats.cacheCreationTokens ?? 0;
  byModel[key].count++;
}

export function addMessageUsageToByModel(
  byModel: UsageByModel,
  message: Pick<SessionMessage, 'usage'>,
  fallbackProviderId?: string,
): void {
  const usage = message.usage;
  if (!usage) return;

  const providerId = usageProviderId(usage, fallbackProviderId);
  if (usage.modelUsage && Object.keys(usage.modelUsage).length > 0) {
    for (const [model, stats] of Object.entries(usage.modelUsage)) {
      addUsageToByModel(byModel, model, stats, providerId);
    }
    return;
  }

  addUsageToByModel(byModel, usage.model || 'unknown', usage, providerId);
}
