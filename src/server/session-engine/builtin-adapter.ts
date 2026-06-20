import { randomUUID } from 'node:crypto';
import {
  cancelQueueItem,
  cancelImRequest as cancelBuiltinImRequest,
  consumeInjectedTurnOutcome,
  discardInjectedTurnOutcome,
  enqueueUserMessage,
  forceExecuteQueueItem,
  getAndClearLastAgentError,
  getQueueStatus,
  handleAskUserQuestionResponse,
  handlePermissionResponse,
  interruptCurrentResponse,
  isSessionBusy,
  setBackgroundAgentPermissionMode,
  setInteractionScenario,
  setSessionModel,
  setSessionPermissionMode,
  setSessionReasoningEffort,
  waitForSessionIdle,
} from '../agent-session';
import type { PermissionMode } from '../agent-session';
import type { CancelReason } from '../utils/cancellation';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngine,
} from './types';

export function createBuiltinSessionEngine(): SessionEngine {
  return {
    kind: 'builtin',

    isBusy() {
      return isSessionBusy();
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
        return { success: false, enqueued: true, error: 'Execution timed out', status: 408 };
      }
      const outcome = consumeInjectedTurnOutcome(injectedTurnId);
      if (!outcome) {
        return {
          success: false,
          enqueued: true,
          error: 'Injected turn finished without a recorded outcome',
          status: 503,
        };
      }
      if (outcome.status !== 'complete') {
        return {
          success: false,
          enqueued: true,
          error: outcome.error ?? `Injected turn ${outcome.status}`,
          status: 503,
        };
      }
      return {
        success: true,
        enqueued: true,
        assistantMessagePresent: outcome.assistantMessagePresent,
        text: outcome.text,
      };
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

    async respondPermission(requestId, decision) {
      return handlePermissionResponse(requestId, decision);
    },

    async respondAskUserQuestion(requestId, answers) {
      return handleAskUserQuestionResponse(requestId, answers);
    },
  };
}
