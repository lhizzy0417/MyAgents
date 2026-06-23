import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    updateDesktopInteractionScenario: vi.fn(async () => ({ success: true })),
    updateMcpServers: vi.fn(async (servers: Array<{ id: string }>) => ({
      success: true,
      servers: servers.map(server => server.id),
    })),
    updateAgents: vi.fn(async () => ({ success: true })),
    updateProviderEnv: vi.fn(async () => ({ success: true, skipped: 'external-runtime' })),
    updatePermissionMode: vi.fn(async () => ({ success: true })),
    materializePendingDesktopSession: vi.fn(async () => ({
      success: true,
      sessionId: 'real-session',
      metadata: { id: 'real-session', providerEnvJson: '{"apiKey":"secret"}' },
    })),
    getSessionConfigSnapshot: vi.fn(() => ({
      success: true,
      runtime: 'codex',
      model: 'gpt-5',
      mcpServerIds: null,
      agentNames: null,
      permissionMode: 'no-restrictions',
      providerId: null,
      reasoningEffort: 'medium',
    })),
  },
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
}));

import { handleSessionConfigRoute } from './session-config';

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('handleSessionConfigRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.engine.updateDesktopInteractionScenario.mockResolvedValue({ success: true });
    mocks.engine.updateMcpServers.mockImplementation(async (servers: Array<{ id: string }>) => ({
      success: true,
      servers: servers.map(server => server.id),
    }));
    mocks.engine.updateAgents.mockResolvedValue({ success: true });
    mocks.engine.updateProviderEnv.mockResolvedValue({ success: true, skipped: 'external-runtime' });
    mocks.engine.updatePermissionMode.mockResolvedValue({ success: true });
    mocks.engine.materializePendingDesktopSession.mockResolvedValue({
      success: true,
      sessionId: 'real-session',
      metadata: { id: 'real-session', providerEnvJson: '{"apiKey":"secret"}' },
    });
  });

  it('validates desktop interaction scenario before calling the engine', async () => {
    const response = await handleSessionConfigRoute(
      '/api/interaction-scenario/set',
      new Request('http://local/api/interaction-scenario/set', {
        method: 'POST',
        body: JSON.stringify({ scenario: { type: 'cron' } }),
      }),
    );

    expect(response?.status).toBe(400);
    expect(await readJson(response as Response)).toEqual({
      success: false,
      error: 'Invalid desktop interaction scenario.',
    });
    expect(mocks.engine.updateDesktopInteractionScenario).not.toHaveBeenCalled();
  });

  it('applies MCP server updates through the active engine', async () => {
    const response = await handleSessionConfigRoute(
      '/api/mcp/set',
      new Request('http://local/api/mcp/set', {
        method: 'POST',
        body: JSON.stringify({ servers: [{ id: 'fs' }, { id: 'git' }] }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({
      success: true,
      servers: ['fs', 'git'],
    });
    expect(mocks.engine.updateMcpServers).toHaveBeenCalledWith([{ id: 'fs' }, { id: 'git' }]);
  });

  it('preserves the legacy provider route response shape even when the engine skips mutation', async () => {
    const response = await handleSessionConfigRoute(
      '/api/provider/set',
      new Request('http://local/api/provider/set', {
        method: 'POST',
        body: JSON.stringify({ providerEnv: { ANTHROPIC_API_KEY: 'secret' } }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({ success: true });
    expect(mocks.engine.updateProviderEnv).toHaveBeenCalledWith({ ANTHROPIC_API_KEY: 'secret' });
  });

  it('reads session config from the active engine snapshot', async () => {
    const response = await handleSessionConfigRoute(
      '/api/session/config',
      new Request('http://local/api/session/config'),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({
      success: true,
      runtime: 'codex',
      model: 'gpt-5',
      mcpServerIds: null,
      agentNames: null,
      permissionMode: 'no-restrictions',
      providerId: null,
      reasoningEffort: 'medium',
    });
  });

  it('materializes a pending desktop session through the active engine', async () => {
    const response = await handleSessionConfigRoute(
      '/api/session/materialize',
      new Request('http://local/api/session/materialize', {
        method: 'POST',
        body: JSON.stringify({
          workspacePath: '/tmp/workspace',
          snapshotPatch: { permissionMode: 'plan' },
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(await readJson(response as Response)).toEqual({
      success: true,
      sessionId: 'real-session',
      metadata: { id: 'real-session', providerEnvJson: '[redacted]' },
    });
    expect(mocks.engine.materializePendingDesktopSession).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      phase: undefined,
      preparedSessionId: undefined,
      snapshotPatch: { permissionMode: 'plan' },
    });
  });

  it('passes pending materialize phase and prepared id through to the active engine', async () => {
    const response = await handleSessionConfigRoute(
      '/api/session/materialize',
      new Request('http://local/api/session/materialize', {
        method: 'POST',
        body: JSON.stringify({
          workspacePath: '/tmp/workspace',
          phase: 'commit',
          preparedSessionId: 'prepared-session',
        }),
      }),
    );

    expect(response?.status).toBe(200);
    expect(mocks.engine.materializePendingDesktopSession).toHaveBeenCalledWith({
      workspacePath: '/tmp/workspace',
      phase: 'commit',
      preparedSessionId: 'prepared-session',
      snapshotPatch: undefined,
    });
  });
});
