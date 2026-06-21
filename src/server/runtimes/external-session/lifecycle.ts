import type { InteractionScenario } from '../../system-prompt';
import type { TurnAnalyticsSource } from '../../types/session';
import type { RuntimeType } from '../../../shared/types/runtime';
import type { SystemInitInfo } from '../../../shared/types/system';
import type { AgentRuntime, RuntimeProcess } from '../types';
import type { ExternalSessionState, ExternalSystemInitPayload } from './types';

let activeProcess: RuntimeProcess | null = null;
let activeRuntime: AgentRuntime | null = null;
let isRunning = false;
let startingPromise: Promise<void> | null = null;
let startingSessionId: string | null = null;
let userRequestedExternalStop = false;

let lastSessionId = '';
let lastWorkspacePath = '';
let lastScenario: InteractionScenario = { type: 'desktop' };
let lastAnalyticsSource: TurnAnalyticsSource = 'desktop';
let lastRuntimeSessionId = '';

let externalSessionState: ExternalSessionState = 'idle';
let externalSystemInitPayload: ExternalSystemInitPayload | null = null;
let isPrewarmingSession = false;

export function resetExternalLifecycleState(): void {
  activeProcess = null;
  activeRuntime = null;
  isRunning = false;
  startingPromise = null;
  startingSessionId = null;
  userRequestedExternalStop = false;
  lastRuntimeSessionId = '';
  lastAnalyticsSource = 'desktop';
  externalSystemInitPayload = null;
  externalSessionState = 'idle';
  isPrewarmingSession = false;
}

export async function awaitExternalLifecycleStarting(): Promise<void> {
  if (startingPromise) {
    await startingPromise;
  }
}

export function isExternalLifecycleStarting(): boolean {
  return Boolean(startingPromise);
}

export function beginExternalLifecycleStart(sessionId: string): () => void {
  let resolveStarting!: () => void;
  startingPromise = new Promise<void>((resolve) => {
    resolveStarting = resolve;
  });
  startingSessionId = sessionId;
  return () => {
    startingPromise = null;
    startingSessionId = null;
    resolveStarting();
  };
}

export function updateExternalLifecycleStartingSessionId(expected: string, next: string): void {
  if (startingSessionId === expected) {
    startingSessionId = next;
  }
}

export function setExternalActiveRuntime(runtime: AgentRuntime | null): void {
  activeRuntime = runtime;
}

export function getExternalActiveRuntime(): AgentRuntime | null {
  return activeRuntime;
}

export function setExternalActiveProcess(process: RuntimeProcess | null): void {
  activeProcess = process;
}

export function getExternalActiveProcess(): RuntimeProcess | null {
  return activeProcess;
}

export function getExternalActivePair(): { runtime: AgentRuntime; process: RuntimeProcess } | null {
  if (!activeRuntime || !activeProcess) return null;
  return { runtime: activeRuntime, process: activeProcess };
}

export function clearExternalActiveRuntimeProcess(): void {
  activeProcess = null;
  activeRuntime = null;
  isRunning = false;
}

export function setExternalLifecycleRunning(value: boolean): void {
  isRunning = value;
}

export function isExternalLifecycleRunning(): boolean {
  return isRunning;
}

export function isExternalLifecycleActive(): boolean {
  return isRunning && activeProcess !== null && !activeProcess.exited;
}

export function bindExternalSessionContext(input: {
  sessionId: string;
  workspacePath: string;
  scenario: InteractionScenario;
  analyticsSource?: TurnAnalyticsSource;
}): void {
  lastSessionId = input.sessionId;
  lastWorkspacePath = input.workspacePath;
  lastScenario = input.scenario;
  lastAnalyticsSource = input.analyticsSource ?? input.scenario.type;
}

export function getExternalLifecycleSessionId(): string {
  return lastSessionId;
}

export function getExternalLifecycleWorkspacePath(): string {
  return lastWorkspacePath;
}

export function getExternalLifecycleScenario(): InteractionScenario {
  return lastScenario;
}

export function getExternalLifecycleAnalyticsSource(): TurnAnalyticsSource {
  return lastAnalyticsSource;
}

export function setExternalLifecycleAnalyticsSource(source: TurnAnalyticsSource): void {
  lastAnalyticsSource = source;
}

export function setExternalRuntimeSessionId(id: string): void {
  lastRuntimeSessionId = id;
}

export function clearExternalRuntimeSessionId(): void {
  lastRuntimeSessionId = '';
}

export function getExternalRuntimeSessionId(): string {
  return lastRuntimeSessionId;
}

export function getCurrentExternalBoundSessionId(): string {
  return startingSessionId || lastSessionId;
}

export function setExternalLifecycleState(state: ExternalSessionState): void {
  externalSessionState = state;
}

export function getExternalLifecycleState(): ExternalSessionState {
  return externalSessionState;
}

export function setExternalSystemInitPayload(payload: ExternalSystemInitPayload | null): void {
  externalSystemInitPayload = payload;
}

export function getExternalSystemInitPayloadSnapshot(): ExternalSystemInitPayload | null {
  return externalSystemInitPayload;
}

export function setExternalPrewarmingSession(value: boolean): void {
  isPrewarmingSession = value;
}

export function isExternalPrewarmingSession(): boolean {
  return isPrewarmingSession;
}

export function clearExternalPrewarmingSession(): void {
  isPrewarmingSession = false;
  if (externalSystemInitPayload) {
    externalSystemInitPayload = { ...externalSystemInitPayload, prewarm: undefined };
  }
}

export function markExternalUserRequestedStop(): void {
  userRequestedExternalStop = true;
}

export function getExternalUserRequestedStop(): boolean {
  return userRequestedExternalStop;
}

export function consumeExternalUserRequestedStop(): boolean {
  const value = userRequestedExternalStop;
  userRequestedExternalStop = false;
  return value;
}

export function resetExternalUserRequestedStop(): void {
  userRequestedExternalStop = false;
}

export function buildExternalSystemInitPayload(input: {
  info: SystemInitInfo;
  runtime: RuntimeType;
}): ExternalSystemInitPayload {
  return {
    info: { ...input.info },
    sessionId: lastSessionId,
    prewarm: isPrewarmingSession || undefined,
    runtime: input.runtime,
  };
}

