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

  it("external: preserves literal 'default' to pin a session back to runtime defaults", () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      reasoningEffort: 'max',
      runtimeConfig: { model: 'gpt-5.2-codex', reasoningEffort: 'default' },
    }));

    expect(snap.reasoningEffort).toBe('default');
  });

  it('runtime override snapshots the target runtime view instead of post-hoc mutating runtime', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'builtin',
      model: 'claude-opus-4-7',
      reasoningEffort: 'max',
      permissionMode: 'fullAgency',
      runtimeConfig: { model: 'gemini-3.1-pro-preview', reasoningEffort: 'xhigh', permissionMode: 'yolo' },
    }), { runtimeOverride: 'codex' });

    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBeUndefined();
    expect(snap.reasoningEffort).toBeUndefined();
    expect(snap.permissionMode).toBeUndefined();
    expect(snap.configSnapshotAt).toBeTruthy();
  });

  it('external: drops obviously foreign runtimeConfig fields before writing a snapshot', () => {
    const snap = snapshotForOwnedSession(makeAgent({
      runtime: 'codex',
      runtimeConfig: {
        model: 'claude-opus-4-7',
        reasoningEffort: 'max',
        permissionMode: 'fullAgency',
      },
    }));

    expect(snap.runtime).toBe('codex');
    expect(snap.model).toBeUndefined();
    expect(snap.reasoningEffort).toBeUndefined();
    expect(snap.permissionMode).toBeUndefined();
  });

  it('absent on both → undefined (resolver falls back to agent at read time)', () => {
    expect(snapshotForOwnedSession(makeAgent({})).reasoningEffort).toBeUndefined();
  });

  it('IM live-follow snapshot stays effort-free (D4: re-resolves per turn)', () => {
    const snap = snapshotForImSession(makeAgent({ reasoningEffort: 'max' }));
    expect('reasoningEffort' in snap).toBe(false);
  });
});
