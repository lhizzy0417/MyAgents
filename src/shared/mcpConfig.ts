import type { McpServerDefinition } from './config-types';

type AgentMcpConfig = {
  mcpEnabledServers?: unknown;
  mcpServersJson?: unknown;
};

export type McpConfigContainer = {
  mcpServers?: McpServerDefinition[];
  mcpEnabledServers?: string[];
  mcpServerEnv?: Record<string, Record<string, string>>;
  mcpServerArgs?: Record<string, string[]>;
  agents?: unknown[];
};

type RemoteMcpDefinition = McpServerDefinition & {
  type: 'http' | 'sse';
  url: string;
};

function isPromotableRemoteMcpDefinition(server: unknown): server is RemoteMcpDefinition {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  const candidate = server as { id?: unknown; name?: unknown; type?: unknown; url?: unknown };
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && (candidate.type === 'http' || candidate.type === 'sse')
    && typeof candidate.url === 'string'
    && candidate.url.length > 0;
}

function parseMcpServerEntries(raw: unknown): unknown[] {
  const parsed = typeof raw === 'string'
    ? (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })()
    : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed;
}

function normalizeMcpServersJson(servers: unknown[]): string | undefined {
  return servers.length > 0 ? JSON.stringify(servers) : undefined;
}

function hasMcpServerId(entry: unknown, serverId: string): boolean {
  return !!entry
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as { id?: unknown }).id === serverId;
}

function asAgentMcpConfig(agent: unknown): (Record<string, unknown> & AgentMcpConfig) | null {
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  return agent as Record<string, unknown> & AgentMcpConfig;
}

/**
 * Heal a legacy Agent-only MCP catalogue split:
 * `agents[].mcpEnabledServers` references a custom HTTP/SSE server whose full
 * definition exists only in `agents[].mcpServersJson`, while the global
 * `config.mcpServers` registry is missing it.
 *
 * This is the shared TypeScript twin of the Rust reader's
 * `promote_agent_mcp_json_to_global_value`.
 */
export function promoteAgentMcpJsonToGlobal<T extends McpConfigContainer>(config: T): boolean {
  const agents = Array.isArray(config.agents) ? config.agents : [];
  if (agents.length === 0) return false;

  const globalServers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];
  const globalEnabled = new Set(Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : []);
  const knownIds = new Set(globalServers.map(server => server.id));
  let changed = false;

  for (const agent of agents) {
    const a = asAgentMcpConfig(agent);
    if (!a) continue;
    const enabledIds = Array.isArray(a.mcpEnabledServers)
      ? new Set(a.mcpEnabledServers.filter((id): id is string => typeof id === 'string' && id.length > 0))
      : new Set<string>();
    if (enabledIds.size === 0) continue;

    for (const entry of parseMcpServerEntries(a.mcpServersJson)) {
      if (!isPromotableRemoteMcpDefinition(entry)) continue;
      const server = entry;
      if (!enabledIds.has(server.id) || server.isBuiltin || knownIds.has(server.id)) continue;
      const normalized: McpServerDefinition = { ...server, isBuiltin: false };
      globalServers.push(normalized);
      knownIds.add(normalized.id);
      globalEnabled.add(normalized.id);
      changed = true;
    }
  }

  if (changed) {
    config.mcpServers = globalServers;
    config.mcpEnabledServers = Array.from(globalEnabled);
  }
  return changed;
}

function pruneAgentMcpReference(agent: AgentMcpConfig, serverId: string): boolean {
  let changed = false;

  if (Array.isArray(agent.mcpEnabledServers)) {
    const nextEnabled = agent.mcpEnabledServers.filter(id => id !== serverId);
    if (nextEnabled.length !== agent.mcpEnabledServers.length) {
      agent.mcpEnabledServers = nextEnabled;
      changed = true;
    }
  }

  const currentEntries = parseMcpServerEntries(agent.mcpServersJson);
  if (currentEntries.length > 0) {
    const nextEntries = currentEntries.filter(entry => !hasMcpServerId(entry, serverId));
    if (nextEntries.length !== currentEntries.length) {
      const serialized = normalizeMcpServersJson(nextEntries);
      if (serialized === undefined) {
        delete agent.mcpServersJson;
      } else {
        agent.mcpServersJson = serialized;
      }
      changed = true;
    }
  }

  return changed;
}

function withoutKey<T>(record: T | undefined, key: string): T | undefined {
  if (!record || typeof record !== 'object' || Array.isArray(record) || !(key in record)) return record;
  const next = { ...(record as Record<string, unknown>) };
  delete next[key];
  return next as T;
}

/**
 * Remove a custom MCP server everywhere it can be resurrected from:
 * global catalogue, global enabled gate, env/args overrides, and legacy
 * per-Agent selected runtime payloads.
 */
export function removeMcpServerEverywhere<T extends McpConfigContainer>(config: T, serverId: string): T {
  const next = { ...config } as McpConfigContainer;

  next.mcpServers = (Array.isArray(config.mcpServers) ? config.mcpServers : [])
    .filter(server => server.id !== serverId);
  next.mcpEnabledServers = (Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : [])
    .filter(id => id !== serverId);
  next.mcpServerEnv = withoutKey(config.mcpServerEnv, serverId);
  next.mcpServerArgs = withoutKey(config.mcpServerArgs, serverId);

  if (Array.isArray(config.agents)) {
    next.agents = config.agents.map(agent => {
      const a = asAgentMcpConfig(agent);
      if (!a) return agent;
      const cloned = { ...a };
      return pruneAgentMcpReference(cloned, serverId) ? cloned : agent;
    });
  }

  return next as T;
}
