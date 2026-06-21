import { randomUUID } from 'node:crypto';
import {
  cancelQueueItem,
  cancelImRequest as cancelBuiltinImRequest,
  consumeInjectedTurnOutcome,
  discardInjectedTurnOutcome,
  enqueueUserMessage,
  forkSession,
  forceExecuteQueueItem,
  getAndClearLastAgentError,
  getAgents,
  getAgentState,
  getLastBuiltinAssistantText,
  getMcpServers,
  getMessages,
  getPendingInteractiveRequests,
  getQueueStatus,
  getSessionId,
  getSessionModel,
  getSessionPermissionMode,
  getSessionReasoningEffort,
  getStreamingAssistantId,
  getSystemInitInfo,
  handleAskUserQuestionResponse,
  handlePermissionResponse,
  interruptCurrentResponse,
  isSessionBusy,
  materializeCurrentSessionMetadataForPublishedReset,
  resetSession,
  rewindSession,
  setAgents,
  setBackgroundAgentPermissionMode,
  setInteractionScenario,
  setMcpServers,
  setSessionModel,
  setSessionPermissionMode,
  setSessionProviderEnv,
  setSessionReasoningEffort,
  stripPlaywrightResults,
  switchToSession,
  waitForSessionIdle,
} from '../agent-session';
import type { MessageWire, PermissionMode } from '../agent-session';
import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { CancelReason } from '../utils/cancellation';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngineReplayMessage,
  SessionEngine,
} from './types';
import { decideBuiltinInjectedTurnResult } from '../session-core/turn-result-policy';
import { getSessionData } from '../SessionStore';
import { getLatestAssistantResultFromMessages, NO_TEXT_RESPONSE } from '../inbox/latest-result';
import { shrinkReplayContentForClient } from '../utils/session-message-preview';
import type { SessionMessage } from '../types/session';

function getLatestBuiltinResult(): string {
  let latestResult = getLastBuiltinAssistantText();
  if (!latestResult.trim()) {
    const data = getSessionData(getSessionId());
    latestResult = data
      ? getLatestAssistantResultFromMessages(data.messages)
      : NO_TEXT_RESPONSE;
  }
  return latestResult.trim() || NO_TEXT_RESPONSE;
}

function messageWireToSessionMessage(message: MessageWire): SessionMessage {
  return {
    id: message.id,
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : JSON.stringify(stripPlaywrightResults(message.content)),
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments?.map(a => ({
      id: a.id,
      name: a.name,
      mimeType: a.mimeType,
      path: a.savedPath ?? a.relativePath ?? '',
    })),
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
}

function messageWireToReplayMessage(message: MessageWire): SessionEngineReplayMessage {
  const strippedContent = typeof message.content !== 'string'
    ? stripPlaywrightResults(message.content)
    : message.content;
  const content = shrinkReplayContentForClient(strippedContent);
  return {
    id: message.id,
    role: message.role,
    content,
    timestamp: message.timestamp,
    sdkUuid: message.sdkUuid,
    attachments: message.attachments,
    metadata: message.metadata,
    usage: message.usage,
    toolCount: message.toolCount,
    durationMs: message.durationMs,
  };
}

export function createBuiltinSessionEngine(): SessionEngine {
  return {
    kind: 'builtin',

    isBusy() {
      return isSessionBusy();
    },

    getRuntimeIdentity() {
      return {
        kind: 'builtin',
        runtime: 'builtin',
        sessionId: getSessionId(),
      };
    },

    getLiveSessionState() {
      return {
        sessionState: getAgentState().sessionState,
        isBusy: isSessionBusy(),
      };
    },

    getLatestAssistantResult() {
      return {
        sessionId: getSessionId(),
        latestResult: getLatestBuiltinResult(),
      };
    },

    getStreamReplaySnapshot() {
      const streamingId = getStreamingAssistantId();
      const replayMessages = getMessages()
        .filter(message => !(streamingId && message.id === streamingId))
        .map(messageWireToReplayMessage);
      const systemInitInfo = getSystemInitInfo();
      return {
        initState: getAgentState(),
        replayMessages,
        systemInitPayload: systemInitInfo ? { info: systemInitInfo } : undefined,
        pendingInteractiveRequests: getPendingInteractiveRequests(),
      };
    },

    getSessionConfigSnapshot() {
      const model = getSessionModel();
      const mcpServers = getMcpServers();
      const agents = getAgents();
      return {
        success: true,
        runtime: 'builtin',
        model: model ?? null,
        mcpServerIds: mcpServers?.map(s => s.id) ?? null,
        agentNames: agents ? Object.keys(agents) : null,
        permissionMode: getSessionPermissionMode(),
        reasoningEffort: getSessionReasoningEffort() ?? 'default',
      };
    },

    getLiveSessionOverlay(sessionId: string) {
      if (sessionId !== getSessionId()) {
        return { isActive: false };
      }
      return {
        isActive: true,
        runtime: 'builtin',
        inMemoryMessages: getMessages().map(messageWireToSessionMessage),
      };
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      setInteractionScenario(request.scenario);
      if (request.backgroundAgentPermissionMode) {
        setBackgroundAgentPermissionMode(request.backgroundAgentPermissionMode);
      }
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode,
        request.model,
        request.providerEnv,
        request.reasoningEffort,
        { source: 'desktop' },
        undefined,
        undefined,
        request.analyticsSource,
        { fromDesktopChatSend: true },
      );
      if (result.error) {
        return { success: false, error: result.error, status: 429 };
      }
      return {
        success: true,
        queued: result.queued,
        queueId: result.queueId,
        isInFlight: result.isInFlight,
        deliveryMode: result.deliveryMode,
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      setInteractionScenario(request.scenario);
      const result = await enqueueUserMessage(
        request.message,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        request.model,
        request.providerEnv,
        request.reasoningEffort,
        request.metadata,
        request.requestId,
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued };
    },

    cancelImRequest(requestId, reason) {
      return cancelBuiltinImRequest(requestId, reason as CancelReason | undefined);
    },

    async enqueueBackgroundMessage(request) {
      setInteractionScenario(request.scenario);
      const result = await enqueueUserMessage(
        request.text,
        request.images,
        request.permissionMode as PermissionMode | undefined,
        request.model,
        request.providerEnv,
        request.reasoningEffort,
        request.metadata,
      );
      if (result.error) {
        return { success: false, error: result.error, status: 503 };
      }
      return { success: true, queued: result.queued };
    },

    enqueueInboxMessage(request) {
      return enqueueUserMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { source: 'desktop' },
        undefined,
        request.inboxMeta,
      );
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      setInteractionScenario(request.scenario);
      getAndClearLastAgentError();
      const injectedTurnId = randomUUID();
      const enqueueResult = await enqueueUserMessage(
        request.prompt,
        [],
        request.permissionMode as PermissionMode | undefined,
        request.model,
        request.providerEnv,
        request.reasoningEffort,
        request.metadata,
        undefined,
        undefined,
        undefined,
        { injectedTurnId },
      );
      if (enqueueResult.error) {
        return { success: false, enqueued: false, error: enqueueResult.error, status: 503 };
      }
      const completed = await waitForSessionIdle(request.timeoutMs, request.pollMs ?? 1000);
      if (!completed) {
        let retainForLateTerminal = true;
        if (enqueueResult.queued && enqueueResult.queueId) {
          const cancelResult = await cancelQueueItem(enqueueResult.queueId);
          retainForLateTerminal = cancelResult.status !== 'cancelled';
        }
        discardInjectedTurnOutcome(injectedTurnId, { retainForLateTerminal });
        return { ...decideBuiltinInjectedTurnResult({ idleCompleted: false }), enqueued: true };
      }
      const outcome = consumeInjectedTurnOutcome(injectedTurnId);
      return { ...decideBuiltinInjectedTurnResult({ idleCompleted: true, outcome }), enqueued: true };
    },

    async stopTurn() {
      const stopped = await interruptCurrentResponse();
      return stopped ? { success: true } : { success: true, alreadyStopped: true };
    },

    cancelQueuedMessage(queueId) {
      return cancelQueueItem(queueId);
    },

    forceQueuedMessage(queueId) {
      return forceExecuteQueueItem(queueId);
    },

    getQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForSessionIdle(timeoutMs, pollMs);
    },

    async updateModel(model, opts) {
      setSessionModel(model, opts);
      return { success: true };
    },

    async updatePermissionMode(mode) {
      setSessionPermissionMode(mode as PermissionMode);
      return { success: true };
    },

    async updateReasoningEffort(effort) {
      setSessionReasoningEffort(effort);
      return { success: true };
    },

    async updateRuntimeConfig() {
      return {
        success: false,
        error: 'Runtime config endpoint is only for external runtimes',
      };
    },

    async prewarm() {
      return { success: false, error: 'Pre-warm is only for external runtimes' };
    },

    restoreInitialSession() {
      return false;
    },

    async respondPermission(requestId, decision) {
      return handlePermissionResponse(requestId, decision);
    },

    async respondAskUserQuestion(requestId, answers) {
      return handleAskUserQuestionResponse(requestId, answers);
    },

    rewindToUserMessage(userMessageId) {
      return rewindSession(userMessageId);
    },

    async retryLastExternalUserMessage() {
      return {
        success: false,
        status: 400,
        error: 'external-retry is only for external runtimes; builtin uses /chat/rewind',
      };
    },

    forkAtAssistantMessage(messageId) {
      return forkSession(messageId);
    },

    async updateProviderEnv(providerEnv) {
      setSessionProviderEnv(providerEnv);
      return { success: true };
    },

    async updateMcpServers(servers) {
      setMcpServers(servers);
      return { success: true, servers: servers.map(s => s.id) };
    },

    async updateAgents(agents) {
      setAgents(agents as Record<string, AgentDefinition>);
      return { success: true };
    },

    async updateDesktopInteractionScenario(scenario) {
      setInteractionScenario(scenario);
      return { success: true };
    },

    async switchToExistingSession(sessionId) {
      const success = await switchToSession(sessionId);
      return success
        ? { success: true, sessionId }
        : { success: false, error: 'Session not found.', status: 404 };
    },

    async resetForNewDesktopSession() {
      await resetSession();
      return { success: true, sessionId: getSessionId() };
    },

    async resetForNewImSession() {
      await resetSession();
      await materializeCurrentSessionMetadataForPublishedReset();
      return { success: true, sessionId: getSessionId() };
    },
  };
}
