import { describe, expect, it } from 'vitest';

import {
  drainPendingSessionWatches,
  pendingSessionWatchCount,
  registerPendingSessionWatch,
} from './watch-registry';

describe('session watch registry', () => {
  it('drains one-shot watches', () => {
    drainPendingSessionWatches();
    registerPendingSessionWatch({
      watchId: 'watch-1',
      watcherSessionId: 'session-a',
      targetSessionId: 'session-b',
      targetLabel: 'B',
      targetStateAtRegistration: 'running',
      registeredAt: '2026-06-20T12:00:00.000Z',
    });

    expect(pendingSessionWatchCount()).toBe(1);
    expect(drainPendingSessionWatches()).toHaveLength(1);
    expect(pendingSessionWatchCount()).toBe(0);
  });
});
