import { PRESET_MCP_SERVERS } from '../../shared/config-types';
import { removeMcpServerFromAppConfig } from '../../shared/mcpConfig';
import {
  atomicModifyConfig,
  atomicModifyProjects,
  loadConfig,
  type ProjectSlim,
} from '../utils/admin-config';
import { managementApi } from '../utils/management-api-client';
import { removeMcpServerFromSessionSnapshots } from '../SessionStore';

export interface McpRemovalResult {
  id: string;
  customDefinitionExisted: boolean;
  projectUpdated: number;
  sessionUpdated: number;
  taskUpdated: number;
  cronUpdated: number;
}

export class McpRemovalError extends Error {
  readonly recoveryHint: unknown | undefined;

  constructor(message: string, recoveryHint?: unknown) {
    super(message);
    this.name = 'McpRemovalError';
    this.recoveryHint = recoveryHint;
  }
}

const PRESET_MCP_IDS = new Set(PRESET_MCP_SERVERS.map(server => server.id));

function countAndRemoveFromProjects(projects: ProjectSlim[], serverId: string): {
  projects: ProjectSlim[];
  updated: number;
} {
  let updated = 0;
  const nextProjects = projects.map(project => {
    if (!Array.isArray(project.mcpEnabledServers) || !project.mcpEnabledServers.includes(serverId)) {
      return project;
    }
    updated++;
    return {
      ...project,
      mcpEnabledServers: project.mcpEnabledServers.filter(id => id !== serverId),
    };
  });
  return { projects: nextProjects, updated };
}

async function removeMcpServerFromProjects(serverId: string): Promise<number> {
  let updated = 0;
  await atomicModifyProjects(projects => {
    const result = countAndRemoveFromProjects(projects, serverId);
    updated = result.updated;
    return result.projects;
  });
  return updated;
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function removeMcpServerFromRustStores(serverId: string): Promise<{
  taskUpdated: number;
  cronUpdated: number;
}> {
  const response = await managementApi('/api/mcp/remove-references', 'POST', { serverId });
  if (!response.ok) {
    throw new McpRemovalError(
      String(response.error ?? 'Failed to remove MCP references from Task/Cron stores'),
      response.recoveryHint,
    );
  }
  return {
    taskUpdated: readCount(response.taskUpdated),
    cronUpdated: readCount(response.cronUpdated),
  };
}

export async function removeCustomMcpServerCascade(serverId: string): Promise<McpRemovalResult> {
  if (!serverId) {
    throw new McpRemovalError('Missing required field: id');
  }
  if (PRESET_MCP_IDS.has(serverId)) {
    throw new McpRemovalError(
      `Cannot remove built-in MCP server '${serverId}'. Use disable instead.`,
    );
  }

  const config = loadConfig();
  const customDefinitionExisted = Array.isArray(config.mcpServers)
    && config.mcpServers.some(server => server.id === serverId);

  const projectUpdated = await removeMcpServerFromProjects(serverId);
  const sessionUpdated = await removeMcpServerFromSessionSnapshots(serverId);
  const rustUpdated = await removeMcpServerFromRustStores(serverId);

  await atomicModifyConfig(c => {
    const latestHasDefinition = Array.isArray(c.mcpServers)
      && c.mcpServers.some(server => server.id === serverId);
    if (!customDefinitionExisted && latestHasDefinition) {
      throw new McpRemovalError(
        `MCP server '${serverId}' was re-added during cleanup-only remove; retry remove if you want to delete the new identity.`,
      );
    }
    return removeMcpServerFromAppConfig(c, serverId);
  });

  return {
    id: serverId,
    customDefinitionExisted,
    projectUpdated,
    sessionUpdated,
    taskUpdated: rustUpdated.taskUpdated,
    cronUpdated: rustUpdated.cronUpdated,
  };
}
