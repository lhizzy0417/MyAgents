import { describe, expect, it } from 'vitest';

import { buildSessionSnapshotPatchUpdates } from './session-snapshot-patch';
import type { SessionMetadata } from '../types/session';

function metadata(partial: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: 'session-1',
    agentDir: '/workspace',
    title: 'Session',
    createdAt: '2026-06-24T00:00:00.000Z',
    lastActiveAt: '2026-06-24T00:00:00.000Z',
    ...partial,
  };
}

describe('buildSessionSnapshotPatchUpdates', () => {
  it('promotes a legacy model-only patch with a complete snapshot baseline', () => {
    const updates = buildSessionSnapshotPatchUpdates({
      existing: metadata({ runtime: 'builtin' }),
      baseSnapshot: {
        runtime: 'builtin',
        providerId: 'zhipu',
        model: 'glm-4.7',
        permissionMode: 'fullAgency',
        reasoningEffort: 'default',
        mcpEnabledServers: ['fs'],
        enabledPluginIds: ['reviewer'],
      },
      payload: { model: 'glm-4.7-air' },
      nowIso: '2026-06-24T01:00:00.000Z',
    });

    expect(updates).toEqual({
      runtime: 'builtin',
      providerId: 'zhipu',
      model: 'glm-4.7-air',
      permissionMode: 'fullAgency',
      reasoningEffort: 'default',
      mcpEnabledServers: ['fs'],
      enabledPluginIds: ['reviewer'],
      configSnapshotAt: '2026-06-24T01:00:00.000Z',
    });
  });

  it('lets existing metadata override the agent baseline before applying the explicit patch', () => {
    const updates = buildSessionSnapshotPatchUpdates({
      existing: metadata({
        providerId: 'deepseek',
        model: 'deepseek-v4-flash',
        permissionMode: 'fullAgency',
      }),
      baseSnapshot: {
        providerId: 'zhipu',
        model: 'glm-4.7',
        permissionMode: 'auto',
      },
      payload: { model: 'deepseek-v4-pro' },
      nowIso: '2026-06-24T01:00:00.000Z',
    });

    expect(updates).toMatchObject({
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      permissionMode: 'fullAgency',
      configSnapshotAt: '2026-06-24T01:00:00.000Z',
    });
  });

  it('clears stale providerEnvJson when providerId changes without an explicit env payload', () => {
    const updates = buildSessionSnapshotPatchUpdates({
      existing: metadata({ configSnapshotAt: '2026-06-24T00:30:00.000Z' }),
      payload: { providerId: 'deepseek', model: 'deepseek-v4-pro' },
      nowIso: '2026-06-24T01:00:00.000Z',
    });

    expect(updates).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-v4-pro',
      providerEnvJson: undefined,
      configSnapshotAt: '2026-06-24T01:00:00.000Z',
    });
  });

  it('uses runtime defaults when no agent baseline exists during promotion', () => {
    const updates = buildSessionSnapshotPatchUpdates({
      existing: metadata(),
      payload: { model: 'deepseek-v4-pro' },
      nowIso: '2026-06-24T01:00:00.000Z',
    });

    expect(updates).toEqual({
      runtime: 'builtin',
      model: 'deepseek-v4-pro',
      permissionMode: 'auto',
      reasoningEffort: 'default',
      configSnapshotAt: '2026-06-24T01:00:00.000Z',
    });
  });

  it('does not stamp configSnapshotAt for metadata-only patches', () => {
    const updates = buildSessionSnapshotPatchUpdates({
      existing: metadata(),
      payload: {},
      nowIso: '2026-06-24T01:00:00.000Z',
    });

    expect(updates).toEqual({});
  });
});
