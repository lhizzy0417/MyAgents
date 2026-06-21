import type { InboxTurnMeta } from '../../inbox/types';
import type { ExternalPendingInteractiveRequest } from './types';

let activeRequestId: string | null = null;
let currentTurnInboxMeta: InboxTurnMeta | null = null;

const currentTurnAttachmentHints: string[] = [];
const pendingPermissionSuggestions = new Map<string, unknown[] | undefined>();
const pendingExternalAskUserQuestions = new Map<string, { input: Record<string, unknown> }>();
const pendingExternalInteractiveRequests = new Map<string, ExternalPendingInteractiveRequest>();

export function resetExternalInteractiveState(): void {
  activeRequestId = null;
  currentTurnInboxMeta = null;
  currentTurnAttachmentHints.length = 0;
  pendingPermissionSuggestions.clear();
  pendingExternalAskUserQuestions.clear();
  pendingExternalInteractiveRequests.clear();
}

export function getExternalActiveRequestId(): string | null {
  return activeRequestId;
}

export function setExternalActiveRequestId(requestId: string | null | undefined): void {
  activeRequestId = requestId ?? null;
}

export function clearExternalActiveRequestId(): void {
  activeRequestId = null;
}

export function setExternalTurnInboxMeta(meta: InboxTurnMeta | null): void {
  currentTurnInboxMeta = meta;
}

export function getExternalTurnInboxMeta(): InboxTurnMeta | null {
  return currentTurnInboxMeta;
}

export function clearExternalTurnInboxMeta(): void {
  currentTurnInboxMeta = null;
}

export function resetExternalTurnAttachmentHints(): void {
  currentTurnAttachmentHints.length = 0;
}

export function addExternalTurnAttachmentHint(hint: string): void {
  currentTurnAttachmentHints.push(hint);
}

export function getExternalTurnAttachmentHintsSnapshot(): string[] {
  return [...currentTurnAttachmentHints];
}

export function snapshotExternalTurnReplyState(): {
  inboxMeta: InboxTurnMeta | null;
  attachmentHints: string[];
} {
  const inboxMeta = currentTurnInboxMeta;
  currentTurnInboxMeta = null;
  const attachmentHints = currentTurnAttachmentHints.splice(0);
  return { inboxMeta, attachmentHints };
}

export function setExternalPermissionSuggestions(requestId: string, suggestions: unknown[] | undefined): void {
  pendingPermissionSuggestions.set(requestId, suggestions);
}

export function consumeExternalPermissionSuggestions(requestId: string): unknown[] | undefined {
  const suggestions = pendingPermissionSuggestions.get(requestId);
  pendingPermissionSuggestions.delete(requestId);
  return suggestions;
}

export function getExternalPermissionSuggestions(requestId: string): unknown[] | undefined {
  return pendingPermissionSuggestions.get(requestId);
}

export function clearExternalPermissionSuggestions(): void {
  pendingPermissionSuggestions.clear();
}

export function setExternalAskUserQuestion(
  requestId: string,
  value: { input: Record<string, unknown> },
): void {
  pendingExternalAskUserQuestions.set(requestId, value);
}

export function getExternalAskUserQuestion(
  requestId: string,
): { input: Record<string, unknown> } | undefined {
  return pendingExternalAskUserQuestions.get(requestId);
}

export function hasExternalAskUserQuestion(requestId: string): boolean {
  return pendingExternalAskUserQuestions.has(requestId);
}

export function deleteExternalAskUserQuestion(requestId: string): void {
  pendingExternalAskUserQuestions.delete(requestId);
}

export function clearExternalAskUserQuestions(): void {
  pendingExternalAskUserQuestions.clear();
}

export function setExternalInteractiveRequest(
  requestId: string,
  request: ExternalPendingInteractiveRequest,
): void {
  pendingExternalInteractiveRequests.set(requestId, request);
}

export function getExternalInteractiveRequest(requestId: string): ExternalPendingInteractiveRequest | undefined {
  return pendingExternalInteractiveRequests.get(requestId);
}

export function deleteExternalInteractiveRequest(requestId: string): void {
  pendingExternalInteractiveRequests.delete(requestId);
}

export function getExternalInteractiveRequestEntries(): IterableIterator<[string, ExternalPendingInteractiveRequest]> {
  return pendingExternalInteractiveRequests.entries();
}

export function getExternalInteractiveRequestsSnapshot(): ExternalPendingInteractiveRequest[] {
  return Array.from(pendingExternalInteractiveRequests.values());
}

export function hasExternalInteractiveRequests(): boolean {
  return pendingExternalInteractiveRequests.size > 0;
}

export function clearExternalInteractiveRequests(): void {
  pendingExternalInteractiveRequests.clear();
}
