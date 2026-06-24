import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getEffectiveMcpServers } from './admin-config';
import { getDefaultEnabledPluginIdsForWorkspace } from '../plugins/store';

let scratch: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf-8');
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'myagents-win-path-'));
  mkdirSync(join(scratch, '.myagents'), { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = scratch;
  process.env.USERPROFILE = scratch;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  rmSync(scratch, { recursive: true, force: true });
});

describe('Windows workspace path identity for server config helpers', () => {
  it('resolves effective MCP servers across Windows separator, drive-case, and trailing-slash variants', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
        isBuiltin: false,
      }],
      mcpEnabledServers: ['win-custom'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Win Project',
      path: 'C:\\Users\\Me\\Project',
      mcpEnabledServers: ['win-custom'],
    }]);

    expect(getEffectiveMcpServers('c:/users/me/project/').map((server) => server.id))
      .toEqual(['win-custom']);
  });

  it('does not match malformed empty project paths when resolving effective MCP servers', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      mcpServers: [{
        id: 'win-custom',
        name: 'Windows Custom',
        type: 'stdio',
        command: 'node',
        isBuiltin: false,
      }],
      mcpEnabledServers: ['win-custom'],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Malformed Project',
      mcpEnabledServers: ['win-custom'],
    }]);

    expect(getEffectiveMcpServers('')).toEqual([]);
  });

  it('reads Agent plugin defaults across Windows path identity variants', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [{
        id: 'agent-1',
        name: 'Agent',
        enabled: true,
        workspacePath: 'C:\\Users\\Me\\Project',
        enabledPluginIds: ['reviewer', 'charts'],
      }],
    });

    expect(getDefaultEnabledPluginIdsForWorkspace('c:/users/me/project/'))
      .toEqual(['reviewer', 'charts']);
  });

  it('falls back to Project plugin defaults across Windows path identity variants', () => {
    writeJson(join(scratch, '.myagents', 'config.json'), {
      agents: [],
    });
    writeJson(join(scratch, '.myagents', 'projects.json'), [{
      id: 'project-1',
      name: 'Win Project',
      path: 'C:\\Users\\Me\\Project',
      enabledPluginIds: ['workspace-plugin'],
    }]);

    expect(getDefaultEnabledPluginIdsForWorkspace('c:/users/me/project/'))
      .toEqual(['workspace-plugin']);
  });
});
