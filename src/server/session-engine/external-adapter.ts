import { broadcast } from '../sse';
import {
  cancelExternalQueueItem,
  cancelExternalImRequest,
  didLastTurnSucceed,
  enqueueExternalSendForDesktop,
  forceExecuteExternalQueueItem,
  getExternalQueueStatus,
  getLastExternalAssistantText,
  isExternalSessionActive,
  prewarmExternalSession,
  respondExternalAskUserQuestion,
  respondExternalPermission,
  sendExternalMessage,
  setExternalModel,
  setExternalPermissionMode,
  setExternalReasoningEffort,
  stopExternalSession,
  updateExternalRuntimeConfig,
  waitForExternalSessionIdle,
} from '../runtimes/external-session';
import type {
  DesktopAdmissionResult,
  DesktopMessageRequest,
  ImAdmissionResult,
  ImMessageRequest,
  InjectedTurnRequest,
  InjectedTurnResult,
  SessionEngine,
} from './types';

export function createExternalSessionEngine(): SessionEngine {
  return {
    kind: 'external',

    isBusy() {
      return isExternalSessionActive();
    },

    async sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult> {
      const sent = enqueueExternalSendForDesktop(
        request.text,
        request.images,
        request.permissionMode,
        request.model,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          analyticsSource: request.analyticsSource,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        },
      );
      sent.dispatch
        .then((result) => {
          if (!result.queued && result.error) {
            console.error(`[chat] external send failed: ${result.error}`);
            broadcast('chat:agent-error', { message: result.error });
          }
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[chat] external send threw: ${msg}`);
          broadcast('chat:agent-error', { message: msg });
        });
      return {
        success: true,
        queued: sent.queued,
        queueId: sent.queueId,
      };
    },

    async enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult> {
      const result = await sendExternalMessage(
        request.message,
        request.images,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
          requestId: request.requestId,
        },
      );
      if (!result.queued) {
        return {
          success: false,
          error: result.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: result.queued };
    },

    cancelImRequest(requestId, reason) {
      return cancelExternalImRequest(requestId, reason);
    },

    async enqueueBackgroundMessage(request) {
      const result = await sendExternalMessage(
        request.text,
        request.images,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        },
      );
      if (!result.queued) {
        return {
          success: false,
          error: result.error ?? 'Failed to send via external runtime',
          status: 503,
        };
      }
      return { success: true, queued: result.queued };
    },

    enqueueInboxMessage(request) {
      return sendExternalMessage(
        request.text,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: { type: 'desktop' },
          inboxMeta: request.inboxMeta,
        },
      );
    },

    async runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult> {
      const result = await sendExternalMessage(
        request.prompt,
        undefined,
        undefined,
        undefined,
        {
          sessionId: request.sessionId,
          workspacePath: request.workspacePath,
          scenario: request.scenario,
          permissionMode: request.permissionMode,
          model: request.model,
          reasoningEffort: request.reasoningEffort,
        },
      );
      if (!result.queued) {
        return {
          success: false,
          enqueued: false,
          error: result.error ?? 'Failed to start external runtime turn',
          status: 503,
        };
      }
      const completed = await waitForExternalSessionIdle(request.timeoutMs, request.pollMs ?? 1000);
      if (!completed) {
        return { success: false, enqueued: true, error: 'Execution timed out', status: 408 };
      }
      if (!didLastTurnSucceed()) {
        return { success: false, enqueued: true, error: 'External runtime turn failed', status: 503 };
      }
      return { success: true, enqueued: true, text: getLastExternalAssistantText() };
    },

    async stopTurn() {
      if (!isExternalSessionActive()) {
        return { success: true, alreadyStopped: true };
      }
      const stopped = await stopExternalSession();
      return { success: true, alreadyStopped: !stopped };
    },

    async cancelQueuedMessage(queueId) {
      const cancelledText = cancelExternalQueueItem(queueId);
      return cancelledText === null
        ? { status: 'not_found' as const }
        : { status: 'cancelled' as const, cancelledText };
    },

    forceQueuedMessage(queueId) {
      return forceExecuteExternalQueueItem(queueId);
    },

    getQueueStatus: getExternalQueueStatus,

    waitIdle(timeoutMs, pollMs) {
      return waitForExternalSessionIdle(timeoutMs, pollMs);
    },

    updateModel(model) {
      return setExternalModel(model);
    },

    updatePermissionMode(mode) {
      return setExternalPermissionMode(mode);
    },

    updateReasoningEffort(effort) {
      return setExternalReasoningEffort(effort);
    },

    updateRuntimeConfig(patch, options) {
      return updateExternalRuntimeConfig(patch, { source: options?.source ?? 'runtime-config' });
    },

    async prewarm(options) {
      return prewarmExternalSession({
        sessionId: options.sessionId,
        workspacePath: options.workspacePath,
        scenario: { type: 'desktop' },
        model: options.model,
        permissionMode: options.permissionMode,
      });
    },

    async respondPermission(requestId, decision, reason) {
      await respondExternalPermission(requestId, decision, reason);
      return true;
    },

    respondAskUserQuestion(requestId, answers) {
      return respondExternalAskUserQuestion(requestId, answers);
    },

    didLastTurnSucceed,
  };
}
