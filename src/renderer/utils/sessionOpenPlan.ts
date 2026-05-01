import { VALID_RUNTIMES, type RuntimeType } from '../../shared/types/runtime';

export interface SessionOpenTabState {
  id: string;
  sessionId: string | null;
}

export interface SessionOpenActivationState {
  tab_id: string | null;
  task_id: string | null;
}

export type SessionOpenPlan =
  | { type: 'jump-to-tab'; tabId: string }
  | {
    type: 'open-new-tab';
    reason: 'runtime-mismatch' | 'current-cron-running';
    targetRuntime?: RuntimeType;
    currentRuntime?: RuntimeType;
  }
  | { type: 'attach-existing-sidecar'; taskId: string }
  | { type: 'switch-current-tab' };

export interface SessionOpenPlanInput {
  tabs: readonly SessionOpenTabState[];
  targetSessionId: string;
  multiAgentRuntime: boolean;
  currentRuntime?: RuntimeType;
  targetRuntime?: RuntimeType;
  targetActivation?: SessionOpenActivationState | null;
  currentTabCronRunning: boolean;
}

export function normalizeRuntime(value: string | null | undefined): RuntimeType {
  return VALID_RUNTIMES.includes(value as RuntimeType) ? value as RuntimeType : 'builtin';
}

export function planSessionOpen(input: SessionOpenPlanInput): SessionOpenPlan {
  const existingTab = input.tabs.find(tab => tab.sessionId === input.targetSessionId);
  if (existingTab) {
    return { type: 'jump-to-tab', tabId: existingTab.id };
  }

  // Attach to a sidecar already owned by a cron task BEFORE checking runtime mismatch.
  // The cron sidecar is keyed by sessionId; its runtime is fixed at spawn time. We're
  // not hot-swapping the current Tab's sidecar — we're switching this Tab to point at
  // the already-running cron sidecar (current Tab's old sidecar gets owner-released).
  // Routing through `open-new-tab(runtime-mismatch)` here calls
  // `activateSession(..., taskId: null)` and overwrites the cron's activation record,
  // breaking ownership. Attach preserves task_id via the dedicated cron path.
  if (input.targetActivation?.task_id) {
    return { type: 'attach-existing-sidecar', taskId: input.targetActivation.task_id };
  }

  if (
    input.multiAgentRuntime
    && input.currentRuntime
    && input.targetRuntime
    && input.currentRuntime !== input.targetRuntime
  ) {
    return {
      type: 'open-new-tab',
      reason: 'runtime-mismatch',
      currentRuntime: input.currentRuntime,
      targetRuntime: input.targetRuntime,
    };
  }

  if (input.currentTabCronRunning) {
    return { type: 'open-new-tab', reason: 'current-cron-running' };
  }

  return { type: 'switch-current-tab' };
}
