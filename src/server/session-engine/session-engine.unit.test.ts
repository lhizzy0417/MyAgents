import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    useExternal: false,
    externalActive: false,
    pendingExternalAsk: false,
  };

  return {
    state,
    broadcast: vi.fn(),
    cancelBuiltinImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelQueueItem: vi.fn<() => Promise<
      | { status: 'cancelled'; cancelledText: string }
      | { status: 'not_found' | 'not_cancelled' | 'unavailable' | 'error' }
    >>(async () => ({ status: 'not_found' as const })),
    consumeInjectedTurnOutcome: vi.fn<(injectedTurnId: string) => {
      status: 'complete' | 'stopped' | 'error';
      assistantMessagePresent: boolean;
      text: string;
      error?: string;
    }>(() => ({
      status: 'complete' as const,
      assistantMessagePresent: true,
      text: 'builtin answer',
    })),
    discardInjectedTurnOutcome: vi.fn(),
    enqueueUserMessage: vi.fn<(...args: unknown[]) => Promise<{
      queued: boolean;
      queueId?: string;
      isInFlight?: boolean;
      deliveryMode?: 'queue' | 'realtime' | 'turn';
      error?: string;
    }>>(async () => ({ queued: true, queueId: 'q1', isInFlight: false, deliveryMode: 'queue' as const })),
    forceExecuteQueueItem: vi.fn(async () => true),
    getAndClearLastAgentError: vi.fn<() => string | null>(() => null),
    getQueueStatus: vi.fn(() => [{ id: 'q1', messagePreview: 'hello' }]),
    handleAskUserQuestionResponse: vi.fn(() => true),
    handlePermissionResponse: vi.fn(() => true),
    interruptCurrentResponse: vi.fn(async () => false),
    isSessionBusy: vi.fn(() => false),
    setBackgroundAgentPermissionMode: vi.fn(),
    setInteractionScenario: vi.fn(),
    setSessionModel: vi.fn(),
    setSessionPermissionMode: vi.fn(),
    setSessionReasoningEffort: vi.fn(),
    waitForSessionIdle: vi.fn(async () => true),
    cancelExternalImRequest: vi.fn(async () => ({ aborted: false, mode: 'unknown' as const })),
    cancelExternalQueueItem: vi.fn(() => null),
    didLastTurnSucceed: vi.fn(() => true),
    enqueueExternalSendForDesktop: vi.fn(() => ({
      queued: true,
      queueId: 'xq1',
      dispatch: Promise.resolve({ queued: true }),
    })),
    forceExecuteExternalQueueItem: vi.fn(async () => true),
    getActiveRuntimeType: vi.fn(() => 'codex'),
    getExternalQueueStatus: vi.fn(() => [{ id: 'xq1', messagePreview: 'hello' }]),
    getLastExternalAssistantText: vi.fn(() => 'external answer'),
    hasPendingExternalAskUserQuestion: vi.fn((requestId: string) => Boolean(requestId) && state.pendingExternalAsk),
    isExternalSessionActive: vi.fn(() => state.externalActive),
    prewarmExternalSession: vi.fn(async () => ({ prewarmed: true })),
    respondExternalAskUserQuestion: vi.fn(async () => true),
    respondExternalPermission: vi.fn(async () => undefined),
    sendExternalMessage: vi.fn(async () => ({ queued: true })),
    setExternalModel: vi.fn(async () => ({ success: true })),
    setExternalPermissionMode: vi.fn(async () => ({ success: true })),
    setExternalReasoningEffort: vi.fn(async () => ({ success: true })),
    shouldUseExternalRuntime: vi.fn(() => state.useExternal),
    stopExternalSession: vi.fn(async () => true),
    updateExternalRuntimeConfig: vi.fn(async () => ({ success: true })),
    waitForExternalSessionIdle: vi.fn(async () => true),
  };
});

vi.mock('../agent-session', () => ({
  cancelImRequest: mocks.cancelBuiltinImRequest,
  cancelQueueItem: mocks.cancelQueueItem,
  consumeInjectedTurnOutcome: mocks.consumeInjectedTurnOutcome,
  discardInjectedTurnOutcome: mocks.discardInjectedTurnOutcome,
  enqueueUserMessage: mocks.enqueueUserMessage,
  forceExecuteQueueItem: mocks.forceExecuteQueueItem,
  getAndClearLastAgentError: mocks.getAndClearLastAgentError,
  getQueueStatus: mocks.getQueueStatus,
  handleAskUserQuestionResponse: mocks.handleAskUserQuestionResponse,
  handlePermissionResponse: mocks.handlePermissionResponse,
  interruptCurrentResponse: mocks.interruptCurrentResponse,
  isSessionBusy: mocks.isSessionBusy,
  setBackgroundAgentPermissionMode: mocks.setBackgroundAgentPermissionMode,
  setInteractionScenario: mocks.setInteractionScenario,
  setSessionModel: mocks.setSessionModel,
  setSessionPermissionMode: mocks.setSessionPermissionMode,
  setSessionReasoningEffort: mocks.setSessionReasoningEffort,
  waitForSessionIdle: mocks.waitForSessionIdle,
}));

vi.mock('../runtimes/external-session', () => ({
  cancelExternalImRequest: mocks.cancelExternalImRequest,
  cancelExternalQueueItem: mocks.cancelExternalQueueItem,
  didLastTurnSucceed: mocks.didLastTurnSucceed,
  enqueueExternalSendForDesktop: mocks.enqueueExternalSendForDesktop,
  forceExecuteExternalQueueItem: mocks.forceExecuteExternalQueueItem,
  getActiveRuntimeType: mocks.getActiveRuntimeType,
  getExternalQueueStatus: mocks.getExternalQueueStatus,
  getLastExternalAssistantText: mocks.getLastExternalAssistantText,
  hasPendingExternalAskUserQuestion: mocks.hasPendingExternalAskUserQuestion,
  isExternalSessionActive: mocks.isExternalSessionActive,
  prewarmExternalSession: mocks.prewarmExternalSession,
  respondExternalAskUserQuestion: mocks.respondExternalAskUserQuestion,
  respondExternalPermission: mocks.respondExternalPermission,
  sendExternalMessage: mocks.sendExternalMessage,
  setExternalModel: mocks.setExternalModel,
  setExternalPermissionMode: mocks.setExternalPermissionMode,
  setExternalReasoningEffort: mocks.setExternalReasoningEffort,
  shouldUseExternalRuntime: mocks.shouldUseExternalRuntime,
  stopExternalSession: mocks.stopExternalSession,
  updateExternalRuntimeConfig: mocks.updateExternalRuntimeConfig,
  waitForExternalSessionIdle: mocks.waitForExternalSessionIdle,
}));

vi.mock('../sse', () => ({
  broadcast: mocks.broadcast,
}));

import {
  getAskUserQuestionResponseEngine,
  getPermissionResponseEngine,
  getSessionEngine,
  stopActiveTurn,
} from './selector';

const desktopScenario = { type: 'desktop' } as const;

describe('session-engine selector and adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.useExternal = false;
    mocks.state.externalActive = false;
    mocks.state.pendingExternalAsk = false;
  });

  it('routes desktop sends through builtin while preserving desktop metadata', async () => {
    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello',
      images: [],
      permissionMode: 'auto',
      model: 'claude-sonnet',
      providerEnv: undefined,
      reasoningEffort: 'medium',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
      analyticsSource: 'floating_ball',
    });

    expect(result).toMatchObject({
      success: true,
      queued: true,
      queueId: 'q1',
      isInFlight: false,
      deliveryMode: 'queue',
    });
    expect(mocks.setInteractionScenario).toHaveBeenCalledWith(desktopScenario);
    expect(mocks.enqueueUserMessage).toHaveBeenCalledWith(
      'hello',
      [],
      'auto',
      'claude-sonnet',
      undefined,
      'medium',
      { source: 'desktop' },
      undefined,
      undefined,
      'floating_ball',
      { fromDesktopChatSend: true },
    );
  });

  it('returns external desktop admission before dispatch finishes and broadcasts dispatch failures', async () => {
    mocks.state.useExternal = true;
    let resolveDispatch!: (result: { queued: boolean; error?: string }) => void;
    const dispatch = new Promise<{ queued: boolean; error?: string }>((resolve) => {
      resolveDispatch = resolve;
    });
    mocks.enqueueExternalSendForDesktop.mockReturnValueOnce({
      queued: true,
      queueId: 'xq-runtime',
      dispatch,
    });

    const result = await getSessionEngine().sendDesktopMessage({
      text: 'hello external',
      images: [],
      permissionMode: 'auto',
      model: 'gpt-5',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: desktopScenario,
    });

    expect(result).toEqual({ success: true, queued: true, queueId: 'xq-runtime' });
    expect(mocks.enqueueExternalSendForDesktop).toHaveBeenCalledWith(
      'hello external',
      [],
      'auto',
      'gpt-5',
      {
        sessionId: 'sid',
        workspacePath: '/workspace',
        scenario: desktopScenario,
        analyticsSource: undefined,
        permissionMode: 'auto',
        model: 'gpt-5',
        reasoningEffort: undefined,
      },
    );
    expect(mocks.broadcast).not.toHaveBeenCalled();

    resolveDispatch({ queued: false, error: 'runtime failed' });
    await dispatch;
    await Promise.resolve();

    expect(mocks.broadcast).toHaveBeenCalledWith('chat:agent-error', { message: 'runtime failed' });
  });

  it('keeps stop fallback on builtin when external runtime is selected but inactive', async () => {
    mocks.state.useExternal = true;
    mocks.state.externalActive = false;

    const result = await stopActiveTurn();

    expect(result).toEqual({ success: true, alreadyStopped: true });
    expect(mocks.stopExternalSession).not.toHaveBeenCalled();
    expect(mocks.interruptCurrentResponse).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued builtin injected turn when the synchronous wait times out', async () => {
    mocks.enqueueUserMessage.mockResolvedValueOnce({
      queued: true,
      queueId: 'q-timeout',
      isInFlight: false,
      deliveryMode: 'queue',
    });
    mocks.cancelQueueItem.mockResolvedValueOnce({
      status: 'cancelled',
      cancelledText: 'run cron',
    });
    mocks.waitForSessionIdle.mockResolvedValueOnce(false);

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'run cron',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'cron', taskId: 'task-1', intervalMinutes: 15, aiCanExit: false },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.cancelQueueItem).toHaveBeenCalledWith('q-timeout');
    expect(mocks.discardInjectedTurnOutcome).toHaveBeenCalledWith(
      expect.any(String),
      { retainForLateTerminal: false },
    );
  });

  it('clears stale builtin agent errors before starting an injected turn', async () => {
    mocks.getAndClearLastAgentError.mockReturnValueOnce('stale previous error');

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({ success: true, text: 'builtin answer' });
    expect(mocks.getAndClearLastAgentError).toHaveBeenCalledTimes(1);
    expect(mocks.getAndClearLastAgentError.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.enqueueUserMessage.mock.invocationCallOrder[0]);
  });

  it('uses the turn-local injected outcome instead of global message history', async () => {
    mocks.consumeInjectedTurnOutcome.mockReturnValueOnce({
      status: 'complete',
      assistantMessagePresent: true,
      text: '',
    });

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: true,
      enqueued: true,
      assistantMessagePresent: true,
      text: '',
    });
    expect(mocks.consumeInjectedTurnOutcome).toHaveBeenCalledTimes(1);
    const injectedTurnId = mocks.consumeInjectedTurnOutcome.mock.calls[0][0];
    expect(typeof injectedTurnId).toBe('string');
    expect(mocks.enqueueUserMessage.mock.calls[0][10]).toEqual({ injectedTurnId });
  });

  it('propagates turn-local injected errors without reading stale assistant text', async () => {
    mocks.consumeInjectedTurnOutcome.mockReturnValueOnce({
      status: 'error',
      assistantMessagePresent: false,
      text: '',
      error: 'turn failed',
    });

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'memory update',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'fullAgency',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'turn failed',
    });
  });

  it('gates external injected turns on the runtime success signal after idle', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockResolvedValueOnce({ queued: true });
    mocks.waitForExternalSessionIdle.mockResolvedValueOnce(true);
    mocks.didLastTurnSucceed.mockReturnValueOnce(false);

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'update memory',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 503,
      error: 'External runtime turn failed',
    });
    expect(mocks.getLastExternalAssistantText).not.toHaveBeenCalled();
  });

  it('forwards model sync source options to the external engine', async () => {
    mocks.state.useExternal = true;

    const result = await getSessionEngine().updateModel('channel-model', { imConfigSync: true });

    expect(result).toEqual({ success: true });
    expect(mocks.setExternalModel).toHaveBeenCalledWith('channel-model', { imConfigSync: true });
  });

  it('stops the external runtime when an injected turn times out', async () => {
    mocks.state.useExternal = true;
    mocks.sendExternalMessage.mockResolvedValueOnce({ queued: true });
    mocks.waitForExternalSessionIdle.mockResolvedValueOnce(false);

    const result = await getSessionEngine().runInjectedTurn({
      prompt: 'heartbeat',
      sessionId: 'sid',
      workspacePath: '/workspace',
      scenario: { type: 'desktop' },
      permissionMode: 'no-restrictions',
      timeoutMs: 1000,
      pollMs: 50,
    });

    expect(result).toMatchObject({
      success: false,
      enqueued: true,
      status: 408,
      error: 'Execution timed out',
    });
    expect(mocks.stopExternalSession).toHaveBeenCalledTimes(1);
    expect(mocks.didLastTurnSucceed).not.toHaveBeenCalled();
  });

  it('routes permission responses by external liveness compatibility', () => {
    mocks.state.useExternal = true;

    mocks.state.externalActive = false;
    expect(getPermissionResponseEngine().kind).toBe('builtin');

    mocks.state.externalActive = true;
    expect(getPermissionResponseEngine().kind).toBe('external');
  });

  it('routes AskUserQuestion responses by pending external request ownership', () => {
    mocks.state.useExternal = true;

    mocks.state.pendingExternalAsk = false;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('builtin');

    mocks.state.pendingExternalAsk = true;
    expect(getAskUserQuestionResponseEngine('ask-1').kind).toBe('external');
  });
});
