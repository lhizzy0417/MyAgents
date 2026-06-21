import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awaitSessionTermination,
  clearAbortFlag,
  getPreWarmFailCount,
  hasMessageResolver,
  incrementPreWarmFailCount,
  isAbortRequested,
  requestAbort,
  resetLifecycleForTest,
  setQuerySession,
  setSessionProcessing,
  setSessionTerminationPromise,
  snapshotLifecycle,
  waitForMessage,
  wakeGenerator,
} from './lifecycle';
import {
  drainQueuedItems,
  findQueuedItemLocation,
  getQueueStatus,
  moveQueuedItemToFront,
  pushMessage,
  pushPendingMidTurn,
  pushTurnBoundary,
  releaseTurnAdmissionTicket,
  removeQueuedItemByQueueId,
  removeQueuedItemByRequestId,
  rescuePendingMidTurnToMessageFront,
  resetQueueForTest,
  setInFlightQueueItem,
  setTurnAdmissionTicket,
  snapshotQueue,
} from './queue';
import {
  beginTurn,
  clearCurrentTurnTextBlocks,
  clearPendingRequests,
  consumeInjectedTurnOutcome,
  discardInjectedTurnOutcome,
  discardInjectedTurnOutcomeWithOptions,
  getCurrentTurnText,
  getPendingRequestIds,
  pushPendingRequest,
  recordInjectedTurnOutcome,
  removePendingRequest,
  resetTurnForTest,
  snapshotTurn,
  terminalCleanup,
  appendCurrentTurnTextBlock,
  setAssistantMessagePresent,
} from './turn';
import {
  consumePendingProviderHistoryBoundaryReset,
  drainDeferredRestart,
  getModel,
  getPermissionMode,
  hasDeferredRestart,
  resetConfigForTest,
  scheduleDeferredRestart,
  setModel,
  setPendingProviderHistoryBoundaryReset,
  setPermissionPlanState,
  snapshotConfig,
} from './config';
import {
  addCurrentSessionUuid,
  clearTranscriptState,
  getCurrentSessionUuids,
  getLastPersistedIndex,
  getMessages,
  nextMessageSequence,
  replaceMessages,
  resetTranscriptForTest,
  setLastPersistedIndex,
  snapshotTranscript,
} from './transcript';
import type { MessageQueueItem } from './types';

function queueItem(id: string, requestId = id): MessageQueueItem {
  return {
    id,
    requestId,
    message: { role: 'user', content: 'hello' },
    messageText: `message ${id}`,
    wasQueued: true,
    resolve: vi.fn(),
  };
}

function pendingItem(id: string, requestId = id) {
  return {
    queueId: id,
    userMessage: { id: `u-${id}`, role: 'user' as const, content: `message ${id}`, timestamp: 'now' },
    sourceItem: queueItem(id, requestId),
  };
}

describe('builtin-session owners', () => {
  beforeEach(() => {
    resetLifecycleForTest();
    resetQueueForTest();
    resetTurnForTest();
    resetConfigForTest();
    resetTranscriptForTest();
  });

  it('lifecycle owns abort flag and wakes the persistent generator', async () => {
    const pending = waitForMessage(() => undefined);
    expect(hasMessageResolver()).toBe(true);

    wakeGenerator(queueItem('q1'));
    await expect(pending).resolves.toMatchObject({ id: 'q1' });
    expect(hasMessageResolver()).toBe(false);

    requestAbort();
    await expect(waitForMessage(() => undefined)).resolves.toBeNull();
    expect(isAbortRequested()).toBe(true);

    clearAbortFlag();
    expect(isAbortRequested()).toBe(false);
  });

  it('lifecycle awaitSessionTermination force-cleans process state on timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    setQuerySession({ close } as never);
    setSessionProcessing(true);
    setSessionTerminationPromise(new Promise(() => undefined));

    const cleanup = vi.fn();
    const result = awaitSessionTermination({
      timeoutMs: 10,
      label: 'unit',
      onTimeoutForceCleanup: cleanup,
    });

    await vi.advanceTimersByTimeAsync(10);
    await result;

    const snapshot = snapshotLifecycle();
    expect(snapshot.querySession).toBeNull();
    expect(snapshot.isProcessing).toBe(false);
    expect(close).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('queue owner covers queued pending turn-boundary and in-flight locations', () => {
    pushMessage(queueItem('q1', 'r1'));
    pushPendingMidTurn(pendingItem('q2', 'r2'));
    pushTurnBoundary({ queueId: 'q3', ready: true, messageText: 'turn', requestId: 'r3' });
    setInFlightQueueItem('q4', { messageText: 'flight', requestId: 'r4' });

    expect(findQueuedItemLocation('q1')?.location).toBe('message');
    expect(findQueuedItemLocation('q2')?.location).toBe('pending-mid-turn');
    expect(findQueuedItemLocation('q3')?.location).toBe('turn-boundary');
    expect(findQueuedItemLocation('q4')?.location).toBe('in-flight');

    expect(removeQueuedItemByRequestId('r2').location).toBe('pending-mid-turn');
    expect(removeQueuedItemByQueueId('q3').location).toBe('turn-boundary');
    expect(removeQueuedItemByRequestId('r4').location).toBe('in-flight');
  });

  it('queue owner drains/rescues and keeps admission ticket scoped', () => {
    pushMessage(queueItem('q1'));
    pushPendingMidTurn(pendingItem('q2'));
    pushTurnBoundary({ queueId: 'q3', ready: true, messageText: 'turn' });
    setTurnAdmissionTicket({ queueId: 'q3', createdAt: 1 });

    expect(rescuePendingMidTurnToMessageFront()).toBe(1);
    expect(snapshotQueue().messageQueue.map(item => item.id)).toEqual(['q2', 'q1']);
    releaseTurnAdmissionTicket('other');
    expect(snapshotQueue().turnAdmissionTicket?.queueId).toBe('q3');
    releaseTurnAdmissionTicket('q3');
    expect(snapshotQueue().turnAdmissionTicket).toBeNull();

    const drained = drainQueuedItems();
    expect(drained.messages.map(item => item.id)).toEqual(['q2', 'q1']);
    expect(drained.turnBoundary.map(item => item.queueId)).toEqual(['q3']);
    expect(getQueueStatus()).toEqual([]);
  });

  it('queue owner force-start reorders non-in-flight locations', () => {
    pushMessage(queueItem('q1'));
    pushMessage(queueItem('q2'));

    expect(moveQueuedItemToFront('q2')).toEqual({ found: true, isInFlight: false });
    expect(snapshotQueue().messageQueue.map(item => item.id)).toEqual(['q2', 'q1']);
  });

  it('turn owner keeps pending request FIFO and injected outcomes turn-local', () => {
    pushPendingRequest('r1');
    pushPendingRequest('r2');
    expect(getPendingRequestIds()).toEqual(['r1', 'r2']);
    expect(removePendingRequest('r2')).toBe(true);
    expect(clearPendingRequests()).toEqual(['r1']);

    beginTurn({ startedAt: 100, injectedTurnId: 'turn-a' });
    appendCurrentTurnTextBlock('hello');
    setAssistantMessagePresent(true);
    recordInjectedTurnOutcome('complete');
    expect(consumeInjectedTurnOutcome('turn-a')).toEqual({
      status: 'complete',
      text: 'hello',
      assistantMessagePresent: true,
    });
    expect(consumeInjectedTurnOutcome('turn-a')).toBeUndefined();
  });

  it('turn owner discards late injected outcomes and owns terminal cleanup', () => {
    beginTurn({
      startedAt: 100,
      injectedTurnId: 'turn-b',
      inboxMeta: {
        fromSessionId: 's1',
        fromLabel: 'source',
        originalMessageId: 'm1',
        originalSnippet: 'late',
        replyBack: true,
      },
    });
    appendCurrentTurnTextBlock('late');
    discardInjectedTurnOutcome('turn-b');
    recordInjectedTurnOutcome('complete');
    expect(consumeInjectedTurnOutcome('turn-b')).toBeUndefined();

    expect(getCurrentTurnText()).toBe('late');
    const cleanup = terminalCleanup();
    expect(cleanup.replyText).toBe('late');
    expect(cleanup.inboxMeta?.fromSessionId).toBe('s1');
    expect(snapshotTurn().currentTurnTextBlocks).toEqual([]);
  });

  it('turn owner can optionally release a discarded injected turn marker', () => {
    beginTurn({ startedAt: 100, injectedTurnId: 'turn-retained' });
    appendCurrentTurnTextBlock('retained');
    discardInjectedTurnOutcomeWithOptions('turn-retained');
    recordInjectedTurnOutcome('complete');
    expect(consumeInjectedTurnOutcome('turn-retained')).toBeUndefined();
    clearCurrentTurnTextBlocks();

    beginTurn({ startedAt: 200, injectedTurnId: 'turn-released' });
    appendCurrentTurnTextBlock('released');
    discardInjectedTurnOutcomeWithOptions('turn-released', { retainForLateTerminal: false });
    recordInjectedTurnOutcome('complete');
    expect(consumeInjectedTurnOutcome('turn-released')).toEqual({
      status: 'complete',
      text: 'released',
      assistantMessagePresent: false,
    });
  });

  it('config owner drains deferred restarts and consumes provider boundary once', () => {
    scheduleDeferredRestart('mcp');
    scheduleDeferredRestart('agents');
    expect(hasDeferredRestart()).toBe(true);
    expect(drainDeferredRestart()).toBe('mcp,agents');
    expect(hasDeferredRestart()).toBe(false);

    setModel('claude-test');
    setPermissionPlanState({ permissionMode: 'plan', prePlanPermissionMode: 'auto' });
    setPendingProviderHistoryBoundaryReset(true);
    expect(getModel()).toBe('claude-test');
    expect(getPermissionMode()).toBe('plan');
    expect(snapshotConfig().prePlanPermissionMode).toBe('auto');
    expect(consumePendingProviderHistoryBoundaryReset()).toBe(true);
    expect(consumePendingProviderHistoryBoundaryReset()).toBe(false);
  });

  it('transcript owner owns sequence cursor and uuid freshness', () => {
    expect(nextMessageSequence()).toBe(1);
    replaceMessages([{ id: 'm1', role: 'user', content: 'hello', timestamp: 'now' }]);
    setLastPersistedIndex(1);
    addCurrentSessionUuid('uuid-1');

    expect(getMessages()).toHaveLength(1);
    expect(getLastPersistedIndex()).toBe(1);
    expect(getCurrentSessionUuids().has('uuid-1')).toBe(true);

    clearTranscriptState();
    expect(snapshotTranscript()).toMatchObject({
      messages: [],
      messageSequence: 0,
      lastPersistedIndex: 0,
    });
  });

  it('prewarm fail count is owned by lifecycle', () => {
    expect(getPreWarmFailCount()).toBe(0);
    expect(incrementPreWarmFailCount()).toBe(1);
  });
});
