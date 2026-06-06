import { describe, expect, it } from 'vitest';

import type { AppConfig, Project, WorkspaceTemplate } from '../types';
import { DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID, PRESET_TEMPLATES } from '../types';
import {
  buildAgentForProject,
  ensureAllProjectsHaveAgent,
  resolveAgentDefaultsForProject,
} from './agentConfigService';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    name: 'workspace',
    path: '/tmp/workspace',
    providerId: null,
    permissionMode: null,
    ...overrides,
  };
}

describe('agentConfigService template Agent defaults', () => {
  it('builds ordinary projects as disabled basic Agents', () => {
    const agent = buildAgentForProject(project(), {
      agentId: 'agent-1',
      defaultPermissionMode: 'auto',
    });

    expect(agent).toMatchObject({
      id: 'agent-1',
      name: 'workspace',
      workspacePath: '/tmp/workspace',
      enabled: false,
      channels: [],
      permissionMode: 'auto',
    });
    expect(agent.heartbeat).toBeUndefined();
    expect(agent.memoryAutoUpdate).toBeUndefined();
  });

  it('applies builtin template defaults and clones nested config objects', () => {
    const templates: WorkspaceTemplate[] = [{
      id: 'agent-template',
      name: 'Agent Template',
      description: '',
      isBuiltin: true,
      agentDefaults: {
        enabled: true,
        heartbeat: {
          enabled: true,
          intervalMinutes: 240,
          ackMaxChars: 300,
          activeHours: { start: '08:00', end: '22:00', timezone: 'Asia/Shanghai' },
        },
        memoryAutoUpdate: {
          enabled: true,
          intervalHours: 24,
          queryThreshold: 5,
          updateWindowStart: '00:00',
          updateWindowEnd: '06:00',
        },
      },
    }];

    const sourceProject = project({
      templateId: 'agent-template',
      templateSource: 'builtin',
      displayName: 'From Template',
      icon: 'lightning',
    });
    const agent = buildAgentForProject(sourceProject, {
      agentId: 'agent-1',
      defaultPermissionMode: 'plan',
      templates,
    });

    expect(agent.enabled).toBe(true);
    expect(agent.name).toBe('From Template');
    expect(agent.icon).toBe('lightning');
    expect(agent.heartbeat).toEqual(templates[0].agentDefaults!.heartbeat);
    expect(agent.memoryAutoUpdate).toEqual(templates[0].agentDefaults!.memoryAutoUpdate);

    agent.heartbeat!.activeHours!.start = '09:00';
    expect(templates[0].agentDefaults!.heartbeat!.activeHours!.start).toBe('08:00');
  });

  it('does not apply builtin defaults to user templates with matching IDs', () => {
    const templates: WorkspaceTemplate[] = [{
      id: 'mino',
      name: 'Mino',
      description: '',
      isBuiltin: true,
      agentDefaults: { enabled: true },
    }];

    const defaults = resolveAgentDefaultsForProject(
      project({ templateId: 'mino', templateSource: 'user' }),
      templates,
    );

    expect(defaults).toBeUndefined();
  });

  it('creates proactive Mino Agents from the preset when a project has builtin template provenance', () => {
    const cfg: AppConfig = {
      defaultPermissionMode: 'auto',
      theme: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [],
    };
    const projects = [project({
      templateId: DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID,
      templateSource: 'builtin',
      displayName: 'Mino',
    })];

    const result = ensureAllProjectsHaveAgent(cfg, projects, cfg.defaultPermissionMode);

    expect(result.changed).toBe(true);
    expect(projects[0].isAgent).toBe(true);
    expect(projects[0].agentId).toBeTruthy();
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents![0]).toMatchObject({
      name: 'Mino',
      enabled: true,
      heartbeat: PRESET_TEMPLATES[0].agentDefaults!.heartbeat,
      memoryAutoUpdate: PRESET_TEMPLATES[0].agentDefaults!.memoryAutoUpdate,
      channels: [],
    });
  });

  it('does not overwrite a project that is already linked to an Agent', () => {
    const cfg: AppConfig = {
      defaultPermissionMode: 'auto',
      theme: 'system',
      minimizeToTray: true,
      showDevTools: false,
      autoStart: false,
      osNotifications: true,
      notificationSound: true,
      agents: [{
        id: 'existing-agent',
        name: 'Existing',
        enabled: false,
        workspacePath: '/tmp/workspace',
        permissionMode: 'plan',
        channels: [],
      }],
    };
    const projects = [project({
      agentId: 'existing-agent',
      templateId: DEFAULT_BUNDLED_WORKSPACE_TEMPLATE_ID,
      templateSource: 'builtin',
    })];

    const result = ensureAllProjectsHaveAgent(cfg, projects, cfg.defaultPermissionMode);

    expect(result.changed).toBe(false);
    expect(cfg.agents![0].enabled).toBe(false);
    expect(cfg.agents![0].heartbeat).toBeUndefined();
    expect(projects[0].isAgent).toBeUndefined();
  });
});
