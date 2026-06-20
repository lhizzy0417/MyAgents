import type { BackgroundAgentPermissionMode } from '../../shared/config-types';
import type { RuntimeConfig } from '../../shared/types/runtime';
import type { EnqueueResult, PermissionMode, ProviderEnv, QueueCancelResult } from '../agent-session';
import type { InteractionScenario } from '../system-prompt';
import type { SessionSource, TurnAnalyticsSource } from '../types/session';
import type { ExternalRuntimeConfigPatch, ImagePayload } from '../runtimes/types';
import type { ExternalConfigSource } from '../runtimes/external-session';
import type { InboxTurnMeta } from '../inbox/types';

export type SessionEngineKind = 'builtin' | 'external';

export type RuntimeConfigPatch = ExternalRuntimeConfigPatch;

export type DesktopMessageRequest = {
  text: string;
  images?: ImagePayload[];
  permissionMode?: PermissionMode;
  backgroundAgentPermissionMode?: BackgroundAgentPermissionMode;
  model?: string;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  sessionId: string;
  workspacePath: string;
  scenario: Extract<InteractionScenario, { type: 'desktop' }>;
  analyticsSource?: TurnAnalyticsSource;
};

export type DesktopAdmissionResult = {
  success: boolean;
  queued?: boolean;
  queueId?: string;
  isInFlight?: boolean;
  deliveryMode?: EnqueueResult['deliveryMode'];
  error?: string;
  status?: number;
};

export type ImMessageRequest = {
  message: string;
  images?: ImagePayload[];
  requestId: string;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  runtimeConfig?: RuntimeConfig | null;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
};

export type ImAdmissionResult = {
  success: boolean;
  queued?: boolean;
  error?: string;
  status?: number;
};

export type ImCancelResult = {
  aborted: boolean;
  mode: 'running' | 'queued' | 'unknown';
};

export type InboxMessageRequest = {
  text: string;
  sessionId: string;
  workspacePath: string;
  inboxMeta?: InboxTurnMeta;
};

export type BackgroundMessageRequest = {
  text: string;
  images?: ImagePayload[];
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  providerEnv?: ProviderEnv | 'subscription';
  reasoningEffort?: string;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
};

export type InjectedTurnRequest = {
  prompt: string;
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: string;
  providerEnv?: ProviderEnv | 'subscription';
  runtimeConfig?: RuntimeConfig | null;
  metadata?: { source: SessionSource; sourceId?: string; senderName?: string };
  timeoutMs: number;
  pollMs?: number;
};

export type InjectedTurnResult = {
  success: boolean;
  enqueued?: boolean;
  assistantMessagePresent?: boolean;
  text?: string;
  error?: string;
  status?: number;
};

export type QueueStatusItem = { id: string; messagePreview: string };

export interface SessionEngine {
  kind: SessionEngineKind;
  isBusy(): boolean;
  sendDesktopMessage(request: DesktopMessageRequest): Promise<DesktopAdmissionResult>;
  enqueueImMessage(request: ImMessageRequest): Promise<ImAdmissionResult>;
  cancelImRequest(requestId: string, reason?: string): Promise<ImCancelResult>;
  enqueueBackgroundMessage(request: BackgroundMessageRequest): Promise<ImAdmissionResult>;
  enqueueInboxMessage(request: InboxMessageRequest): Promise<{ queued: boolean; error?: string }>;
  runInjectedTurn(request: InjectedTurnRequest): Promise<InjectedTurnResult>;
  stopTurn(): Promise<{ success: boolean; alreadyStopped?: boolean; error?: string }>;
  cancelQueuedMessage(queueId: string): Promise<QueueCancelResult>;
  forceQueuedMessage(queueId: string): Promise<boolean>;
  getQueueStatus(): QueueStatusItem[];
  waitIdle(timeoutMs: number, pollMs?: number): Promise<boolean>;
  updateModel(model: string, opts?: { imConfigSync?: boolean }): Promise<{ success: boolean; error?: string }>;
  updatePermissionMode(mode: string): Promise<{ success: boolean; error?: string }>;
  updateReasoningEffort(effort: string): Promise<{ success: boolean; error?: string }>;
  updateRuntimeConfig(
    patch: RuntimeConfigPatch,
    options?: { source?: ExternalConfigSource },
  ): Promise<{ success: boolean; error?: string; skipped?: string }>;
  prewarm(options: {
    sessionId: string;
    workspacePath: string;
    model?: string;
    permissionMode?: string;
  }): Promise<Record<string, unknown>>;
  respondPermission(
    requestId: string,
    decision: 'deny' | 'allow_once' | 'always_allow',
    reason?: string,
  ): Promise<boolean>;
  respondAskUserQuestion(requestId: string, answers: Record<string, string> | null): Promise<boolean>;
  didLastTurnSucceed(): boolean;
}
