// Config load-boundary schema normalization (pure, side-effect free).
//
// Kept as a dependency-free leaf module so it can be unit-tested in the fast
// `unit` pool without pulling Tauri/runtime imports.
import type { AppConfig, McpServerDefinition } from '../types';

/**
 * Restore the "stringified JSON" invariant for agent config fields at the load
 * boundary. `providerEnvJson` / `mcpServersJson` are declared as `string` (they
 * carry a *serialized* JSON blob), but a legacy write path — or a hand-edit —
 * can persist them as a raw JSON object/array. That breaks every strict
 * consumer of the config:
 *
 *   - the renderer's `cmd_start_agent_channel` IPC rejects the whole
 *     `agentConfig` argument with `invalid type: map, expected a string`
 *     (issue #301) → the channel can never start, and retrying never helps
 *     because the bad value is persisted;
 *   - Rust boot-time `read_agent_configs_from_disk` fails the strict
 *     `AgentConfigRust` parse → no agent channels auto-start.
 *
 * Coercing an object back to its stringified form is semantically lossless: the
 * object is exactly what the string is meant to contain, so any downstream
 * `JSON.parse` round-trips to the same value. Idempotent — already-string
 * values are left untouched. Mutates `config` in place and returns whether
 * anything changed (used by tests; callers normalize in-memory on every load
 * and let the disk heal opportunistically on the next config write).
 *
 * MUST stay in sync with the Rust twin `normalize_stringified_json_value`
 * (`src-tauri/src/im/mod.rs`) — the two independent config readers restore the
 * same invariant. Shared regression fixture:
 * `src/shared/__fixtures__/dirtyConfig301.json`.
 */
export function normalizeStringifiedJsonFields(config: AppConfig): boolean {
  const agents = (config as unknown as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return false;

  let changed = false;
  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    const a = agent as Record<string, unknown>;

    if (coerceJsonStringField(a, 'providerEnvJson')) changed = true;
    if (coerceJsonStringField(a, 'mcpServersJson')) changed = true;

    const channels = a.channels;
    if (Array.isArray(channels)) {
      for (const ch of channels) {
        if (!ch || typeof ch !== 'object') continue;
        const overrides = (ch as Record<string, unknown>).overrides;
        if (overrides && typeof overrides === 'object') {
          if (coerceJsonStringField(overrides as Record<string, unknown>, 'providerEnvJson')) {
            changed = true;
          }
        }
      }
    }
  }
  return changed;
}

/**
 * Heal a legacy Agent-only MCP catalogue split:
 * `agents[].mcpEnabledServers` references a custom HTTP/SSE server whose full
 * definition exists only in `agents[].mcpServersJson`, while the global
 * `config.mcpServers` registry is missing it. Runtime self-resolve uses the
 * global registry, so promote those selected custom definitions back to the
 * global layer at the load boundary.
 *
 * This intentionally only enables IDs that were also recovered into the global
 * registry in this pass. If a known global server is disabled globally, loading
 * config must not silently re-enable it just because an Agent still references
 * the ID.
 */
export function promoteAgentMcpJsonToGlobal(config: AppConfig): boolean {
  const agents = (config as unknown as { agents?: unknown }).agents;
  if (!Array.isArray(agents)) return false;

  const globalServers = Array.isArray(config.mcpServers) ? [...config.mcpServers] : [];
  const globalEnabled = new Set(Array.isArray(config.mcpEnabledServers) ? config.mcpEnabledServers : []);
  const knownIds = new Set(globalServers.map(server => server.id));
  let changed = false;

  for (const agent of agents) {
    if (!agent || typeof agent !== 'object') continue;
    const a = agent as Record<string, unknown>;
    const enabledIds = Array.isArray(a.mcpEnabledServers)
      ? new Set(a.mcpEnabledServers.filter((id): id is string => typeof id === 'string' && id.length > 0))
      : new Set<string>();
    if (enabledIds.size === 0 || typeof a.mcpServersJson !== 'string') continue;

    for (const server of parseMcpServerDefinitions(a.mcpServersJson)) {
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

function parseMcpServerDefinitions(raw: string): McpServerDefinition[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPromotableRemoteMcpDefinition);
  } catch {
    return [];
  }
}

function isPromotableRemoteMcpDefinition(server: unknown): server is McpServerDefinition {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  const candidate = server as { id?: unknown; name?: unknown; type?: unknown; url?: unknown };
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && (candidate.type === 'http' || candidate.type === 'sse')
    && typeof candidate.url === 'string'
    && candidate.url.length > 0;
}

/**
 * If `obj[field]` is present but not a string, coerce it back to the field's
 * intended shape:
 *   - object / array → `JSON.stringify` (the serialized blob the field holds);
 *   - any other scalar (number / boolean) → delete it (it can't be a valid
 *     blob, and feeding a bogus string to a downstream `JSON.parse` would just
 *     move the failure elsewhere).
 *
 * Returns true iff it changed the field. `undefined` / `null` / `string` are
 * left untouched (so the pass is idempotent on healthy configs).
 */
function coerceJsonStringField(obj: Record<string, unknown>, field: string): boolean {
  const v = obj[field];
  if (v === undefined || v === null || typeof v === 'string') return false;
  if (typeof v === 'object') {
    obj[field] = JSON.stringify(v);
  } else {
    delete obj[field];
  }
  return true;
}
