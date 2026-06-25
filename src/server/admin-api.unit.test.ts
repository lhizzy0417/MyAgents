import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentSessionMocks = vi.hoisted(() => ({
  agentDir: undefined as string | undefined,
  setMcpServers: vi.fn(),
  setAgents: vi.fn(),
  getMcpServers: vi.fn(() => []),
  getSidecarPort: vi.fn(() => 0),
  forceReloadActiveSession: vi.fn(),
}));

vi.mock('./agent-session', () => ({
  SDK_RESERVED_MCP_NAMES: new Set<string>(),
  getAgentState: () => ({ agentDir: agentSessionMocks.agentDir }),
  setMcpServers: agentSessionMocks.setMcpServers,
  setAgents: agentSessionMocks.setAgents,
  getMcpServers: agentSessionMocks.getMcpServers,
  getSidecarPort: agentSessionMocks.getSidecarPort,
  forceReloadActiveSession: agentSessionMocks.forceReloadActiveSession,
}));

vi.mock('./sse', () => ({
  broadcast: vi.fn(),
}));

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(scratch, '.myagents', 'config.json'), 'utf-8')) as Record<string, unknown>;
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-admin-api-'));
  mkdirSync(join(scratch, '.myagents'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
  agentSessionMocks.agentDir = undefined;
  agentSessionMocks.setMcpServers.mockClear();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('admin-api MCP project scope', () => {
  it('fails project-only enable when the current workspace is not registered', async () => {
    const { handleMcpEnable } = await import('./admin-api');
    agentSessionMocks.agentDir = 'c:/users/me/project/';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
      }],
      mcpEnabledServers: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);

    const result = await handleMcpEnable({ id: 'win-custom', scope: 'project' });

    expect(result.success).toBe(false);
    expect(readConfig().mcpEnabledServers).toEqual([]);
    expect(agentSessionMocks.setMcpServers).not.toHaveBeenCalled();
  });

  it('keeps global enable effective when project scope is skipped for an unregistered workspace', async () => {
    const { handleMcpEnable } = await import('./admin-api');
    agentSessionMocks.agentDir = 'c:/users/me/project/';
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
      }],
      mcpEnabledServers: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), []);

    const result = await handleMcpEnable({ id: 'win-custom', scope: 'both' });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ id: 'win-custom', projectScope: 'project-not-found' });
    expect(readConfig().mcpEnabledServers).toEqual(['win-custom']);
    expect(agentSessionMocks.setMcpServers).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'win-custom' }),
    ]);
  });
});

describe('admin-api MCP remove/disable legacy HTTP servers', () => {
  const remoteHttp = {
    id: 'yuandian-law',
    name: 'YuanDian Law',
    type: 'http',
    url: 'https://mcp.example.com/yuandian-law',
    headers: { Authorization: 'Bearer token' },
    isBuiltin: false,
  };

  it('removes HTTP MCP definitions from global config and Agent legacy payloads', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [remoteHttp],
      mcpEnabledServers: ['yuandian-law'],
      mcpServerEnv: { 'yuandian-law': { TOKEN: 'secret' } },
      mcpServerArgs: { 'yuandian-law': ['--stale'] },
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const agent = (config.agents as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual([]);
    expect(config.mcpServerEnv).toEqual({});
    expect(config.mcpServerArgs).toEqual({});
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('removes Agent-only legacy HTTP MCP servers after Admin API load-boundary promotion', async () => {
    const { handleMcpRemove } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: [],
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpRemove({ id: 'yuandian-law' });
    const config = readConfig();
    const agent = (config.agents as Array<Record<string, unknown>>)[0];

    expect(result.success).toBe(true);
    expect(config.mcpServers).toEqual([]);
    expect(config.mcpEnabledServers).toEqual([]);
    expect(agent.mcpEnabledServers).toEqual([]);
    expect(agent.mcpServersJson).toBeUndefined();
  });

  it('disables Agent-only legacy HTTP MCP servers without letting promotion re-enable them', async () => {
    const { handleMcpDisable } = await import('./admin-api');
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [],
      mcpEnabledServers: [],
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
        mcpEnabledServers: ['yuandian-law'],
        mcpServersJson: JSON.stringify([remoteHttp]),
      }],
    });

    const result = await handleMcpDisable({ id: 'yuandian-law', scope: 'both' });
    const config = readConfig();

    expect(result.success).toBe(true);
    expect((config.mcpServers as Array<Record<string, unknown>>).map(s => s.id)).toEqual(['yuandian-law']);
    expect(config.mcpEnabledServers).toEqual([]);
  });
});
