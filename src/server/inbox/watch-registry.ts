export interface PendingSessionWatch {
  watchId: string;
  watcherSessionId: string;
  watcherResumeWorkspacePath?: string;
  targetSessionId: string;
  targetLabel: string;
  targetStateAtRegistration: string;
  registeredAt: string;
}

const pendingWatches = new Map<string, PendingSessionWatch>();

export function registerPendingSessionWatch(watch: PendingSessionWatch): void {
  pendingWatches.set(watch.watchId, watch);
}

export function drainPendingSessionWatches(): PendingSessionWatch[] {
  const watches = [...pendingWatches.values()];
  pendingWatches.clear();
  return watches;
}

export function pendingSessionWatchCount(): number {
  return pendingWatches.size;
}
