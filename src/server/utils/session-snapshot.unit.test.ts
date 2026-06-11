import { describe, it, expect } from 'vitest';

import { snapshotForOwnedSession, snapshotForImSession } from './session-snapshot';
import type { AgentConfig } from '../../shared/types/agent';

// #324 regression (cross-review Critical): owned desktop/cron sessions must
// FREEZE reasoningEffort at creation, with the same runtime-aware dispatch as
// model (issue #224) — otherwise later agent-level effort changes silently
// change old sessions, violating the D1 ownership contract.
function makeAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: 'a1',
    name: 'A',
    enabled: true,
    workspacePath: '/tmp/ws',
    permissionMode: 'auto',
    channels: [],
    ...overrides,
  };
}

describe('snapshotForOwnedSession — reasoning effort capture (#324)', () => {
  it('builtin: captures agent.reasoningEffort', () => {
    const snap = snapshotForOwnedSession(makeAgent({ reasoningEffort: 'max', model: 'claude-fable-5' }));
    expect(snap.reasoningEffort).toBe('max');
    expect(snap.model).toBe('claude-fable-5');
  });

  it('external: captures runtimeConfig.reasoningEffort, not the builtin field', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      reasoningEffort: 'max', // stale builtin value must NOT leak (issue #224 class)
      runtimeConfig: { model: 'gpt-5.2-codex', reasoningEffort: 'xhigh' },
    }));
    expect(snap.reasoningEffort).toBe('xhigh');
    expect(snap.model).toBe('gpt-5.2-codex');
  });

  it('absent on both → undefined (resolver falls back to agent at read time)', () => {
    expect(snapshotForOwnedSession(makeAgent({})).reasoningEffort).toBeUndefined();
  });

  it('IM live-follow snapshot stays effort-free (D4: re-resolves per turn)', () => {
    const snap = snapshotForImSession(makeAgent({ reasoningEffort: 'max' }));
    expect('reasoningEffort' in snap).toBe(false);
  });
});
