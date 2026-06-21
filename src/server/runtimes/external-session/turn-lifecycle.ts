import { TurnFinalizationGate } from '../external-turn-finalization';
import type { ExternalTurnUsage } from './types';
import type { ContextUsage } from '../../../shared/types/context-usage';

let turnCompleted = false;
let lastTurnSucceeded = false;
let currentTurnStartTime = 0;
let currentTurnUsage: ExternalTurnUsage | null = null;
let currentTurnContextUsage: ContextUsage | null = null;
let currentTurnEstimatedInputTokens = 0;

const turnFinalization = new TurnFinalizationGate();

export function resetExternalTurnLifecycleState(): void {
  turnCompleted = false;
  lastTurnSucceeded = false;
  currentTurnStartTime = 0;
  currentTurnUsage = null;
  currentTurnContextUsage = null;
  currentTurnEstimatedInputTokens = 0;
}

export function resetExternalTurnAccumulators(): void {
  currentTurnUsage = null;
  currentTurnContextUsage = null;
  currentTurnEstimatedInputTokens = 0;
}

export function setExternalTurnCompleted(value: boolean): void {
  turnCompleted = value;
}

export function isExternalTurnCompleted(): boolean {
  return turnCompleted;
}

export function setExternalLastTurnSucceeded(value: boolean): void {
  lastTurnSucceeded = value;
}

export function didExternalLastTurnSucceed(): boolean {
  return lastTurnSucceeded;
}

export function setExternalTurnStartTime(value: number): void {
  currentTurnStartTime = value;
}

export function markExternalTurnStarted(now = Date.now()): void {
  currentTurnStartTime = now;
}

export function clearExternalTurnStartTime(): void {
  currentTurnStartTime = 0;
}

export function getExternalTurnStartTime(): number {
  return currentTurnStartTime;
}

export function setExternalCurrentTurnUsage(usage: ExternalTurnUsage | null): void {
  currentTurnUsage = usage;
}

export function getExternalCurrentTurnUsage(): ExternalTurnUsage | null {
  return currentTurnUsage;
}

export function updateExternalCurrentTurnUsageModel(model: string): void {
  if (currentTurnUsage) {
    currentTurnUsage.model = model;
  }
}

export function setExternalCurrentTurnContextUsage(usage: ContextUsage | null): void {
  currentTurnContextUsage = usage;
}

export function getExternalCurrentTurnContextUsage(): ContextUsage | null {
  return currentTurnContextUsage;
}

export function setExternalCurrentTurnEstimatedInputTokens(tokens: number): void {
  currentTurnEstimatedInputTokens = tokens;
}

export function getExternalCurrentTurnEstimatedInputTokens(): number {
  return currentTurnEstimatedInputTokens;
}

export function isExternalTurnFinalizationInFlight(): boolean {
  return turnFinalization.inFlight;
}

export function trackExternalTurnFinalization(promise: Promise<unknown>): void {
  turnFinalization.track(promise);
}

export function waitExternalTurnFinalization(timeoutMs: number): Promise<boolean> {
  return turnFinalization.settled(timeoutMs);
}

