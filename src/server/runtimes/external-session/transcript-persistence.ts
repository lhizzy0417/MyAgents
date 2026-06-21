import type { MessageUsage, SessionMessage } from '../../types/session';
import {
  saveSessionMessages,
  updateSessionMetadata,
  type SaveSessionMessagesResult,
} from '../../SessionStore';
import { resolveLastRealUserMessagePreview } from '../../utils/session-message-preview';
import type { ContextUsage } from '../../../shared/types/context-usage';

let allSessionMessages: SessionMessage[] = [];
let lastPersistedRuntimeUsageTotals: MessageUsage | null = null;

export function resetExternalTranscriptState(): void {
  allSessionMessages = [];
  lastPersistedRuntimeUsageTotals = null;
}

export function getExternalSessionMessagesRef(): SessionMessage[] {
  return allSessionMessages;
}

export function setExternalSessionMessages(messages: SessionMessage[]): void {
  allSessionMessages = messages;
}

export function clearExternalSessionMessages(): void {
  allSessionMessages = [];
}

export function pushExternalSessionMessage(message: SessionMessage): void {
  allSessionMessages.push(message);
}

export function getExternalSessionMessageCount(): number {
  return allSessionMessages.length;
}

export function findExternalSessionMessageIndex(
  predicate: (message: SessionMessage) => boolean,
): number {
  return allSessionMessages.findIndex(predicate);
}

export function getExternalSessionMessageAt(index: number): SessionMessage | undefined {
  return allSessionMessages[index];
}

export function truncateExternalSessionMessages(length: number): void {
  allSessionMessages.length = length;
}

export function removeExternalSessionMessageById(messageId: string): boolean {
  for (let i = allSessionMessages.length - 1; i >= 0; i -= 1) {
    if (allSessionMessages[i]?.id === messageId) {
      allSessionMessages.splice(i, 1);
      return true;
    }
  }
  return false;
}

export function getLastPersistedRuntimeUsageTotals(): MessageUsage | null {
  return lastPersistedRuntimeUsageTotals;
}

export function setLastPersistedRuntimeUsageTotals(usage: MessageUsage | null): void {
  lastPersistedRuntimeUsageTotals = usage;
}

function describeSaveSessionMessagesFailure(
  result: Extract<SaveSessionMessagesResult, { ok: false }>,
): string {
  switch (result.reason) {
    case 'unindexed-create-refused':
      return `session metadata is missing; refused to create JSONL (${result.count} message(s))`;
    case 'shrink-refused':
      return `append-only save saw shorter memory history (${result.count}) than disk (${result.existingCount})`;
    case 'write-error':
      return result.error;
  }
}

export interface ExternalAssistantTurnPersistInput {
  sessionId: string | null;
  content: string | null;
  durationMs?: number;
  usage: MessageUsage | null | undefined;
  toolCount: number;
  contextUsage: ContextUsage | null;
}

export interface ExternalAssistantTurnPersistResult {
  ok: boolean;
  failureReason?: string;
  messageCount: number;
  appendedAssistant: boolean;
}

export async function appendAndPersistExternalAssistantTurn(
  input: ExternalAssistantTurnPersistInput,
): Promise<ExternalAssistantTurnPersistResult> {
  let appendedAssistant = false;
  if (input.content) {
    allSessionMessages.push({
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      content: input.content,
      timestamp: new Date().toISOString(),
      durationMs: input.durationMs,
      usage: input.usage || undefined,
      toolCount: input.toolCount || undefined,
    });
    appendedAssistant = true;
  }

  if (allSessionMessages.length === 0 || !input.sessionId) {
    return { ok: true, messageCount: allSessionMessages.length, appendedAssistant };
  }

  try {
    const saveResult = await saveSessionMessages(input.sessionId, allSessionMessages, { allowShrink: false });
    if (!saveResult.ok) {
      return {
        ok: false,
        failureReason: describeSaveSessionMessagesFailure(saveResult),
        messageCount: allSessionMessages.length,
        appendedAssistant,
      };
    }

    const { found: foundRealUserMessage, preview: lastMessagePreview } =
      resolveLastRealUserMessagePreview(allSessionMessages);
    await updateSessionMetadata(input.sessionId, {
      ...(foundRealUserMessage ? { lastActiveAt: new Date().toISOString() } : {}),
      lastMessagePreview,
      runtimeUsageTotals: lastPersistedRuntimeUsageTotals ?? undefined,
      ...(input.contextUsage ? { lastContextUsage: input.contextUsage } : {}),
    });
    return { ok: true, messageCount: allSessionMessages.length, appendedAssistant };
  } catch (err) {
    return {
      ok: false,
      failureReason: err instanceof Error ? err.message : String(err),
      messageCount: allSessionMessages.length,
      appendedAssistant,
    };
  }
}
