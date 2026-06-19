/**
 * Sidecar-side config read/write for Admin API
 *
 * Equivalent to the frontend's appConfigService.ts, but using native fs
 * instead of Tauri plugin-fs. Both read/write the same ~/.myagents/config.json.
 * Atomicity is guaranteed by write-to-tmp → rename pattern.
 */

import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  renameSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'fs';
import { resolve } from 'path';
import { getHomeDirOrNull } from './platform';
import { stripBom } from '../../shared/utils';
import { workspacePathsEqual } from '../../shared/workspacePath';
import type { McpServerDefinition } from '../../shared/config-types';
import { applyProviderEnablementAndOrder, isProviderEnabled, PRESET_MCP_SERVERS, PRESET_PROVIDERS } from '../../shared/config-types';
import {
  coerceModelForRuntime,
  coercePermissionModeForRuntime,
  getDefaultRuntimePermissionMode,
  normalizeRuntime,
  type RuntimeType,
} from '../../shared/types/runtime';
import type { SessionMetadata } from '../types/session';
import { coerceReasoningEffortSettingForRuntime } from '../../shared/reasoningEffort';
import { ensureDirSync } from './fs-utils';
import { withFileLock, FileBusyError } from './file-lock';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConfigDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.myagents');
}

function getConfigPath(): string {
  return resolve(getConfigDir(), 'config.json');
}

function getProjectsPath(): string {
  return resolve(getConfigDir(), 'projects.json');
}

const CONFIG_LOCK_TIMEOUT_MS = 5000;
const CONFIG_LOCK_STALE_MS = 30000;

export class ConfigBusyError extends Error {
  readonly code = 'CONFIG_BUSY';

  constructor(message = 'Config busy: could not acquire config.json.lock within 5000ms; retry') {
    super(message);
    this.name = 'ConfigBusyError';
  }
}

// ---------------------------------------------------------------------------
// Minimal types (mirrors renderer/config/types.ts — only the fields we touch)
// ---------------------------------------------------------------------------

/** Lightweight AppConfig subset used by admin operations */
export interface AdminAppConfig {
  // MCP
  mcpServers?: McpServerDefinition[];
  mcpEnabledServers?: string[];
  mcpServerEnv?: Record<string, Record<string, string>>;
  mcpServerArgs?: Record<string, string[]>;
  // CLI tool registry (PRD 0.2.36): per-tool env (API keys etc.), same shape as
  // mcpServerEnv. Read at launch by the ~/.myagents/bin shims — env changes
  // need no shim rewrite.
  cliToolEnv?: Record<string, Record<string, string>>;
  // Experimental gate for user-registered CLI tools. Omitted means disabled.
  cliToolRegistryEnabled?: boolean;
  // Provider
  defaultProviderId?: string;
  providerApiKeys?: Record<string, string>;
  providerVerifyStatus?: Record<string, { status: string; verifiedAt?: string }>;
  providerOrder?: string[];
  disabledProviderIds?: string[];
  // Agent
  agents?: AgentConfigSlim[];
  defaultPermissionMode?: string;
  claudeTranscriptCleanupPeriodDays?: number;
  // Allow passthrough of all other fields
  [key: string]: unknown;
}

/** Minimal Agent config shape for admin operations */
export interface AgentConfigSlim {
  id: string;
  name: string;
  enabled: boolean;
  workspacePath?: string;
  providerId?: string;
  model?: string;
  permissionMode?: string;
  channels?: ChannelConfigSlim[];
  /** PRD 0.2.17 — plugins this Agent enables (subset of globally-visible). */
  enabledPluginIds?: string[];
  [key: string]: unknown;
}

/** Minimal Channel config shape */
export interface ChannelConfigSlim {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
  botToken?: string;
  feishuAppId?: string;
  feishuAppSecret?: string;
  dingtalkClientId?: string;
  dingtalkClientSecret?: string;
  [key: string]: unknown;
}

/** Minimal Project shape */
export interface ProjectSlim {
  id: string;
  name: string;
  path: string;
  mcpEnabledServers?: string[];
  model?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Config read/write
// ---------------------------------------------------------------------------

export function loadConfig(): AdminAppConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const raw = readFileSync(configPath, 'utf-8');
    return JSON.parse(stripBom(raw)) as AdminAppConfig;
  } catch {
    // Malformed JSON — try .bak fallback
    const bakPath = configPath + '.bak';
    if (existsSync(bakPath)) {
      try {
        console.warn('[admin-config] config.json parse failed, falling back to .bak');
        return JSON.parse(stripBom(readFileSync(bakPath, 'utf-8'))) as AdminAppConfig;
      } catch { /* bak also corrupt */ }
    }
    console.error('[admin-config] config.json and .bak both unreadable, returning empty config');
    return {};
  }
}

export function isCliToolRegistryEnabled(config: AdminAppConfig = loadConfig()): boolean {
  return config.cliToolRegistryEnabled === true;
}

/**
 * Cross-process serialized read-modify-write on config.json.
 * Pattern: lock → read fresh → modify → write .tmp → fsync → backup .bak → rename → fsync dir.
 *
 * Async because acquiring the cross-process lockdir polls with `await delay()` —
 * never a sync busy-wait or `Atomics.wait` (Pattern 5 §5.3.4.a).
 */
export async function withConfigLock(
  modifier: (config: AdminAppConfig) => AdminAppConfig | Promise<AdminAppConfig>
): Promise<AdminAppConfig> {
  const configPath = getConfigPath();
  const configDir = getConfigDir();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    ensureDirSync(configDir);
  }

  try {
    return await withFileLock(
      {
        lockPath: configPath + '.lock',
        timeoutMs: CONFIG_LOCK_TIMEOUT_MS,
        staleMs: CONFIG_LOCK_STALE_MS,
      },
      async () => {
        const config = loadConfig();
        const before = JSON.stringify(config);
        const modified = await modifier(config);

        if (JSON.stringify(modified) === before) {
          return modified;
        }

        const tmpPath = configPath + '.tmp';
        const bakPath = configPath + '.bak';

        writeFileSynced(tmpPath, JSON.stringify(modified, null, 2));
        if (existsSync(configPath)) {
          try { copyFileSync(configPath, bakPath); } catch { /* best-effort backup */ }
        }
        renameSync(tmpPath, configPath);
        fsyncDir(configDir);

        return modified;
      }
    );
  } catch (err) {
    if (err instanceof FileBusyError) {
      throw new ConfigBusyError();
    }
    throw err;
  }
}

export async function atomicModifyConfig(
  modifier: (config: AdminAppConfig) => AdminAppConfig | Promise<AdminAppConfig>
): Promise<AdminAppConfig> {
  return withConfigLock(modifier);
}

function writeFileSynced(path: string, content: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeFileSync(fd, content, 'utf-8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Projects read/write
// ---------------------------------------------------------------------------

export function loadProjects(): ProjectSlim[] {
  const path = getProjectsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as ProjectSlim[];
  } catch {
    return [];
  }
}

export function saveProjects(projects: ProjectSlim[]): void {
  const path = getProjectsPath();
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(projects, null, 2), 'utf-8');
  // Pattern 5 fix #13: if rename fails (e.g. permission denied, target on a
  // different filesystem), the .tmp file used to persist forever. Wrap so a
  // failure cleans up the artifact before rethrowing.
  try {
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore — tmp may not exist */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// MCP helpers (preset + custom merge, matching renderer/config/services/mcpService.ts)
// ---------------------------------------------------------------------------

/** Preset MCP servers (statically imported — see top of file) */
function getPresetMcpServers(): McpServerDefinition[] {
  // Filter out presets whose `platforms` field doesn't include the host —
  // keeps platform-specific presets (e.g. cuse on darwin/win32) invisible
  // everywhere on unsupported hosts (catalogue, validation, effective
  // MCP lists, `myagents mcp list`).
  return (PRESET_MCP_SERVERS as McpServerDefinition[]).filter(p =>
    !p.platforms || p.platforms.includes(process.platform)
  );
}

/**
 * Get all MCP servers (preset + custom), with user env/args overrides applied.
 * Mirrors getAllMcpServers() from mcpService.ts.
 */
export function getAllMcpServers(config?: AdminAppConfig): McpServerDefinition[] {
  const c = config ?? loadConfig();
  const presets = getPresetMcpServers();
  const custom = c.mcpServers ?? [];
  const envOverrides = c.mcpServerEnv ?? {};
  const argsOverrides = c.mcpServerArgs ?? {};

  // Custom servers can override presets with same ID
  const customIds = new Set(custom.map(s => s.id));
  const merged = [
    ...presets.filter(p => !customIds.has(p.id)),
    ...custom,
  ];

  // Apply user env/args overrides
  return merged.map(server => {
    const userEnv = envOverrides[server.id];
    const userArgs = argsOverrides[server.id];
    return {
      ...server,
      ...(userEnv ? { env: { ...(server.env || {}), ...userEnv } } : {}),
      ...(userArgs !== undefined ? { args: userArgs } : {}),
    };
  });
}

/**
 * Get globally enabled MCP server IDs
 */
export function getEnabledMcpServerIds(config?: AdminAppConfig): string[] {
  const c = config ?? loadConfig();
  return c.mcpEnabledServers ?? [];
}

/**
 * Get effective MCP servers for a specific project (global enabled ∩ project enabled)
 */
export function getEffectiveMcpServers(projectPath: string): McpServerDefinition[] {
  const config = loadConfig();
  const allServers = getAllMcpServers(config);
  const globalEnabled = new Set(getEnabledMcpServerIds(config));

  // Find project by path
  const projects = loadProjects();
  const project = projects.find(p => p.path === projectPath);
  const projectEnabled = new Set(project?.mcpEnabledServers ?? []);

  if (projectEnabled.size === 0) return [];

  return allServers.filter(s => globalEnabled.has(s.id) && projectEnabled.has(s.id));
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

/** Redact sensitive values for display (show first 4 + last 4 chars) */
export function redactSecret(value: string): string {
  if (value.length <= 10) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

/** Path to custom provider files directory */
export function getProvidersDir(): string {
  const home = getHomeDirOrNull();
  if (!home) throw new Error('Cannot determine home directory');
  return resolve(home, '.myagents', 'providers');
}

/** Find a provider by ID: checks PRESET_PROVIDERS first, then custom files in ~/.myagents/providers/ */
export function findProvider(id: string): Record<string, unknown> | null {
  // Check presets first (statically imported — see top of file).
  // Cast via `unknown` because Provider lacks a string index signature.
  const preset = (PRESET_PROVIDERS as unknown as Array<Record<string, unknown>>)?.find(
    (p: Record<string, unknown>) => p.id === id
  );
  if (preset) return preset;

  // Check custom providers
  try {
    const dir = getProvidersDir();
    const filePath = resolve(dir, `${id}.json`);
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    }
  } catch { /* ignore */ }
  return null;
}

/** Load all custom provider files from ~/.myagents/providers/ */
export function loadCustomProviderFiles(): Array<Record<string, unknown>> {
  try {
    const dir = getProvidersDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as Record<string, unknown>;
        } catch { return null; }
      })
      .filter((p): p is Record<string, unknown> => p !== null && !!p.id);
  } catch { return []; }
}

type ProviderRecord = Record<string, unknown> & { id: string; enabled?: unknown };

function hasProviderId(provider: Record<string, unknown>): provider is ProviderRecord {
  return typeof provider.id === 'string' && provider.id.length > 0;
}

export function getAllEffectiveProviders(config?: AdminAppConfig): ProviderRecord[] {
  const c = config ?? loadConfig();
  const presetProviders = ((PRESET_PROVIDERS ?? []) as unknown as Array<Record<string, unknown>>)
    .filter(hasProviderId);
  const customProviders = loadCustomProviderFiles().filter(hasProviderId);
  return applyProviderEnablementAndOrder([...presetProviders, ...customProviders], c);
}

export function findEffectiveProvider(id: string, config?: AdminAppConfig): ProviderRecord | null {
  if (!id) return null;
  return getAllEffectiveProviders(config).find(provider => provider.id === id) ?? null;
}

export function isProviderDisabled(providerId: string, config?: AdminAppConfig): boolean {
  const provider = findEffectiveProvider(providerId, config);
  return !!provider && !isProviderEnabled(provider);
}

// ---------------------------------------------------------------------------
// Provider resolution (Sidecar self-resolve — eliminates dependency on providerEnvJson snapshots)
// ---------------------------------------------------------------------------

/** Provider environment for SDK subprocess (structural match with ProviderEnv in agent-session.ts) */
export interface ResolvedProviderEnv {
  /** Provider registry id. Metadata only: not forwarded as an SDK env var. */
  providerId?: string;
  baseUrl?: string;
  apiKey?: string;
  authType?: 'auth_token' | 'api_key' | 'both' | 'auth_token_clear_api_key';
  apiProtocol?: 'anthropic' | 'openai';
  maxOutputTokens?: number;
  maxOutputTokensParamName?: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens';
  upstreamFormat?: 'chat_completions' | 'responses';
  modelAliases?: { sonnet?: string; opus?: string; haiku?: string };
}

/**
 * Resolve provider environment from providerId by looking up the real provider definition
 * (preset or custom) and API key from config. Handles ALL providers including custom ones.
 *
 * Returns undefined for subscription providers or if provider/key not found.
 */
export function resolveProviderEnv(
  providerId: string,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  if (!providerId) return undefined;

  const c = config ?? loadConfig();
  const provider = findEffectiveProvider(providerId, c);
  if (!provider) return undefined;
  if (!isProviderEnabled(provider)) return undefined;

  // Subscription providers don't use providerEnv (SDK uses built-in OAuth)
  if (provider.type === 'subscription') return undefined;

  // Get API key from config. PRD 0.2.9 — also reject whitespace-only keys
  // (Codex review): a value like `"  "` is truthy and would silently be
  // sent to the upstream as the Authorization header, producing an opaque
  // 401 instead of an actionable "no API key" error.
  const apiKey = (c.providerApiKeys ?? {})[providerId];
  if (!apiKey || !apiKey.trim()) return undefined;

  // Extract provider config fields (same shape as frontend Chat.tsx builds)
  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  const result: ResolvedProviderEnv = {
    providerId,
    baseUrl: providerConfig.baseUrl ? String(providerConfig.baseUrl) : undefined,
    apiKey,
    authType: (provider.authType as ResolvedProviderEnv['authType']) ?? 'both',
  };
  if (provider.apiProtocol) result.apiProtocol = provider.apiProtocol as ResolvedProviderEnv['apiProtocol'];
  if (provider.maxOutputTokens) result.maxOutputTokens = Number(provider.maxOutputTokens);
  if (provider.maxOutputTokensParamName) result.maxOutputTokensParamName = provider.maxOutputTokensParamName as ResolvedProviderEnv['maxOutputTokensParamName'];
  if (provider.upstreamFormat) result.upstreamFormat = provider.upstreamFormat as ResolvedProviderEnv['upstreamFormat'];

  // Model aliases: merge preset defaults with user overrides (from config.providerModelAliases)
  const presetAliases = (provider as Record<string, unknown>).modelAliases as Record<string, string> | undefined;
  const aliasOverrides = c.providerModelAliases as Record<string, Record<string, string>> | undefined;
  const userOverrides = aliasOverrides?.[providerId];
  const mergedAliases = presetAliases || userOverrides
    ? { ...presetAliases, ...userOverrides }
    : undefined;
  if (mergedAliases && (mergedAliases.sonnet || mergedAliases.opus || mergedAliases.haiku)) {
    result.modelAliases = {
      sonnet: mergedAliases.sonnet,
      opus: mergedAliases.opus,
      haiku: mergedAliases.haiku,
    };
  } else {
    // Fallback: no aliases configured — use provider's primaryModel or first model
    // so sub-agents don't send raw claude-* model names to third-party APIs.
    const primaryModel = (provider as Record<string, unknown>).primaryModel as string | undefined;
    const models = (provider as Record<string, unknown>).models as Array<{ model: string }> | undefined;
    const fallback = primaryModel || models?.[0]?.model;
    if (fallback) {
      result.modelAliases = { sonnet: fallback, opus: fallback, haiku: fallback };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Workspace config resolution (Sidecar self-resolve at startup)
// ---------------------------------------------------------------------------

/**
 * Find the Agent whose workspacePath matches `agentDir` (cross-platform path normalization).
 * Used by session-snapshot helpers to capture the AgentConfig at session creation time (v0.1.69).
 *
 * Returns the raw on-disk shape — callers cast to AgentConfig at use sites (the session snapshot
 * helpers only read `runtime`/`providerId`/`providerEnvJson`/`model`/`permissionMode`/
 * `mcpEnabledServers`, all of which are documented optional/required on AgentConfig).
 */
export function findAgentByWorkspacePath(agentDir: string): AgentConfigSlim | undefined {
  const config = loadConfig();
  const agents = (config.agents ?? []) as AgentConfigSlim[];
  // #320 family: slash-only folding missed drive-letter case + trailing-slash
  // differences (C:\Users vs c:/users/), so the v0.1.69 session-snapshot lookup
  // could silently miss the Agent on Windows — the session then fell back to
  // live-follow and stayed exposed to the #327 config-stomp this snapshot
  // exists to prevent. Use the canonical workspace-path identity.
  return agents.find(a =>
    typeof a.workspacePath === 'string' && workspacePathsEqual(a.workspacePath, agentDir)
  );
}

/**
 * Re-resolve providerEnv for an IM channel from canonical `providerId` (issue #237).
 *
 * The IM bot's Rust runtime caches `provider_env_json` as an Arc at bot start and
 * forwards that blob in every `/api/im/enqueue` payload. The blob can drift away
 * from the agent's canonical `providerId` — channel.overrides.providerEnvJson stays
 * pinned to whatever was written when the user last touched that channel (the
 * Rust hot-reload for `patch.channels` only updates group fields — see
 * `src-tauri/src/im/mod.rs` patch.channels branch), and agent.providerEnvJson can
 * outlive a providerId change if the writer didn't go through patchAgentConfig.
 * Desktop Chat is immune because Chat.tsx builds providerEnv live from React state
 * on every send; IM was not.
 *
 * The fix here mirrors that "live from canonical providerId" behavior on the
 * sidecar side: look up the agent + channel, resolve `providerId` via the same
 * priority chain Rust uses at `src-tauri/src/im/types.rs:968`
 * (`channel.overrides.providerId` → legacy channel-root `channel.providerId`
 * (pre-bc06386) → `agent.providerId` → `config.defaultProviderId`), and
 * rebuild the env via `resolveProviderEnv()`.
 *
 * Returns undefined when:
 *   - the agent can't be matched by workspacePath (legacy IM bot / drift) —
 *     deliberately does NOT fall through to `defaultProviderId` here, since
 *     rerouting every unmatched IM bot to the global default would be strictly
 *     worse than the stale-blob bug we're fixing,
 *   - or when the resolved providerId has no live env (provider deleted /
 *     disabled / no API key).
 *
 * Callers fall back to the legacy `payload.providerEnv` blob in those cases
 * to preserve back-compat for configs the user hasn't migrated yet.
 */
export function resolveImProviderEnv(
  agentDir: string,
  channelId: string | undefined,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  const c = config ?? loadConfig();
  const normalized = agentDir.replace(/\\/g, '/');
  const agents = (c.agents ?? []) as AgentConfigSlim[];
  const agent = agents.find(a =>
    typeof a.workspacePath === 'string' && a.workspacePath.replace(/\\/g, '/') === normalized
  );
  // No agent matched (legacy IM bot / workspace-path drift) — bail out so the
  // caller falls back to `payload.providerEnv`. Returning a resolution against
  // `defaultProviderId` here would silently reroute every legacy IM bot to the
  // global default provider, which is a strictly worse regression than the
  // original stale-blob bug.
  if (!agent) return undefined;
  // Channel provider chain (mirrors Rust `ChannelConfigRust::to_im_config` at
  // src-tauri/src/im/types.rs:968): `overrides.providerId` → channel-root
  // `providerId` (legacy pre-v0.1.45) → agent providerId. The legacy channel-
  // root field is still on disk for users who configured providers via the
  // pre-bc06386 in-IM `/provider` command — skipping it would reroute those
  // configs to the agent default. payload.botId == channel.id under the
  // v0.1.41 Agent architecture (see src-tauri/src/im/mod.rs `channel.id` →
  // `bot_id` mapping at line 4360).
  let channelLevelProviderId: string | undefined;
  if (channelId) {
    const channels = (agent.channels ?? []) as ChannelConfigSlim[];
    const channel = channels.find(ch => ch.id === channelId);
    if (channel) {
      const overrides = (channel.overrides as Record<string, unknown> | undefined) ?? undefined;
      const ovProviderId = overrides?.providerId;
      if (typeof ovProviderId === 'string' && ovProviderId.length > 0) {
        channelLevelProviderId = ovProviderId;
      } else {
        // Legacy root-level channel.providerId (pre-bc06386).
        const legacyProviderId = (channel as Record<string, unknown>).providerId;
        if (typeof legacyProviderId === 'string' && legacyProviderId.length > 0) {
          channelLevelProviderId = legacyProviderId;
        }
      }
    }
  }
  const providerId = channelLevelProviderId
    || agent.providerId
    || (c.defaultProviderId as string | undefined);
  if (!providerId) return undefined;
  return resolveProviderEnv(providerId, c);
}

/**
 * Decode a frozen providerEnv snapshot, enforcing the global enablement gate.
 *
 * Snapshot semantics: sessions / agents / cron tasks freeze provider env at
 * config time, so live edits to baseUrl/apiKey don't break a running session
 * ("snapshot wins"). But "provider globally disabled" must override the
 * snapshot — otherwise cron / IM handover paths silently keep using credentials
 * for a provider the user just turned off.
 *
 * Single source of truth for every snapshot consumer (resolveWorkspaceConfig,
 * cron followAgent, IM handover). Returns undefined when:
 *   - snapshot is missing or malformed
 *   - providerId is known and currently disabled (caller must fail loud)
 */
export function decodeProviderEnvSnapshot(
  snapshotJson: string | null | undefined,
  providerId: string | null | undefined,
  config?: AdminAppConfig,
): ResolvedProviderEnv | undefined {
  if (!snapshotJson) return undefined;
  if (providerId && isProviderDisabled(providerId, config)) return undefined;
  try {
    return JSON.parse(snapshotJson) as ResolvedProviderEnv;
  } catch {
    return undefined;
  }
}

/** Result of self-resolution for a workspace */
export interface WorkspaceResolvedConfig {
  mcpServers: McpServerDefinition[];
  providerEnv: ResolvedProviderEnv | undefined;
  model: string | undefined;
  permissionMode: string;
  /** #324 — reasoning effort setting ('default' | level | undefined). Raw chain
   *  value (NOT normalized); callers run normalizeReasoningEffort() themselves. */
  reasoningEffort: string | undefined;
}

const BUILTIN_PERMISSION_MODES = new Set(['auto', 'plan', 'fullAgency', 'custom']);

function asBuiltinPermissionMode(value: unknown): string | undefined {
  return typeof value === 'string' && BUILTIN_PERMISSION_MODES.has(value)
    ? value
    : undefined;
}

/**
 * Resolve the complete AI configuration for a workspace by reading source data from disk.
 *
 * This eliminates the dependency on pre-serialized snapshot fields (providerEnvJson, mcpServersJson)
 * that can fail to save or go stale. The Sidecar calls this during initializeAgent() so IM Bot
 * sessions work correctly without the frontend having been opened first.
 *
 * For desktop Chat sessions, the frontend's /api/mcp/set and per-message providerEnv will
 * override the self-resolved values — so there is no conflict.
 *
 * v0.1.69 — `sessionMeta`: when provided, the session's snapshot fields take priority
 * over the agent's. This is the read-side complement of `snapshotForOwnedSession()` and
 * implements the layered Option-C semantics from PRD §6 (`session ?? agent`). The
 * fallback is field-by-field: a session may have captured `model` but not
 * `mcpEnabledServers`, in which case the unset fields lazily resolve via agent —
 * this is a *read-only* fallback (no write-back), per PRD §6.4.
 *
 * IM sessions deliberately don't snapshot model/permission/mcp (D4 live-follow), so
 * the session-meta merge is a no-op for them — `meta?.<field>` is undefined and we
 * fall through to the existing agent path. The IM channel-overrides merge happens
 * elsewhere (at the IM bot delivery layer where `channel` context is available).
 */
export function resolveWorkspaceConfig(
  agentDir: string,
  sessionMeta?: SessionMetadata | null,
  options?: { includeMcp?: boolean },
): WorkspaceResolvedConfig {
  const config = loadConfig();
  // MCP resolution is the expensive part here (walks all agents, intersects
  // enable sets, builds McpServerDefinition from disk). Desktop Tab sessions
  // don't need it — the frontend's /api/mcp/set is authoritative — so callers
  // can short-circuit via `{ includeMcp: false }` to skip it entirely.
  const includeMcp = options?.includeMcp !== false;

  // Normalize path separators for cross-platform matching
  const normalizedDir = agentDir.replace(/\\/g, '/');

  // Find matching agent by workspace path
  const agents = (config.agents ?? []) as Array<Record<string, unknown>>;
  const agent = agents.find(a =>
    typeof a.workspacePath === 'string' && a.workspacePath.replace(/\\/g, '/') === normalizedDir
  );
  const project = loadProjects().find(p =>
    typeof p.path === 'string' && p.path.replace(/\\/g, '/') === normalizedDir
  );

  // --- Resolve MCP ---
  // Session snapshot first (PRD §6 D2/D9): if the session captured its own enabled
  // server list, intersect with the global-enabled set so users disabling a server
  // globally still wins (security stays at the global lever, locked sessions just
  // pin their feature surface).
  let mcpServers: McpServerDefinition[] = [];
  if (includeMcp) {
    if (sessionMeta?.mcpEnabledServers) {
      const allServers = getAllMcpServers(config);
      const globalEnabled = new Set(getEnabledMcpServerIds(config));
      const sessionEnabled = new Set(sessionMeta.mcpEnabledServers);
      mcpServers = allServers.filter(s => globalEnabled.has(s.id) && sessionEnabled.has(s.id));
    } else {
      // Lazy fallback for legacy / IM sessions — uses project ∩ global as before.
      mcpServers = getEffectiveMcpServers(agentDir);
    }
  }

  // --- Resolve Provider ---
  // Priority: session.providerId → agent.providerId → config.defaultProviderId → persisted snapshot
  let providerEnv: ResolvedProviderEnv | undefined;
  const providerId = sessionMeta?.providerId
    || (agent?.providerId as string | undefined)
    || (config.defaultProviderId as string | undefined);
  if (providerId) {
    providerEnv = resolveProviderEnv(providerId, config);
  }
  // Snapshot env wins: if the session froze providerEnvJson, prefer that — even if
  // the providerId still resolves cleanly today, the session's intent was the snapshot
  // value (e.g., a custom baseUrl that has since been edited at the agent level).
  // EXCEPT when providerId is globally disabled — decodeProviderEnvSnapshot enforces this.
  //
  // #300 residual: a session whose providerId was changed BEFORE the renderer fix
  // (persistInputOption.ts clears providerEnvJson on providerId change) can hold a
  // providerEnvJson belonging to the OLD provider (e.g. deepseek creds under a
  // skywork-ai providerId). For such pre-fix snapshots this branch still hands the
  // stale env to headless/pre-warm callers. It cannot be auto-distinguished from a
  // legitimately-frozen custom baseUrl (the blob carries no providerId tag), so it is
  // NOT auto-healed here; the session self-heals on its next provider/model change.
  // See issue #300 — a desktop-scoped scrub migration is the follow-up if needed.
  if (sessionMeta?.providerEnvJson) {
    const decoded = decodeProviderEnvSnapshot(sessionMeta.providerEnvJson, providerId, config);
    if (decoded) providerEnv = decoded;
  } else if (!providerEnv && agent?.providerEnvJson) {
    // Backward-compat: legacy sessions without a snapshot fall back to agent's persisted env
    const decoded = decodeProviderEnvSnapshot(agent.providerEnvJson as string, providerId, config);
    if (decoded) providerEnv = decoded;
  }

  const resolvedRuntime: RuntimeType = normalizeRuntime(
    (sessionMeta?.runtime as string | undefined) ?? (agent?.runtime as string | undefined),
  );
  const agentRuntimeConfig = agent?.runtimeConfig as {
    model?: string;
    permissionMode?: string;
    reasoningEffort?: string;
  } | undefined;

  // --- Resolve Model ---
  // Runtime-aware priority:
  // - builtin: session.model → agent.model → provider primary model
  // - external: session.model → agent.runtimeConfig.model → runtime default
  const rawModel = resolvedRuntime === 'builtin'
    ? sessionMeta?.model ?? (agent?.model as string | undefined) ?? undefined
    : sessionMeta?.model ?? agentRuntimeConfig?.model;
  let model = coerceModelForRuntime(rawModel, resolvedRuntime);
  if (resolvedRuntime !== 'builtin'
      && typeof rawModel === 'string'
      && rawModel.trim().length > 0
      && model === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale workspace model='${rawModel}' on runtime='${resolvedRuntime}'; falling back to runtime default. sessionId=${sessionMeta?.id ?? '<none>'} agentDir=${agentDir}`,
    );
  }
  if (!model && providerId && resolvedRuntime === 'builtin') {
    const provider = findEffectiveProvider(providerId, config);
    if (provider && isProviderEnabled(provider)) {
      model = (provider as Record<string, unknown>).primaryModel as string | undefined;
    }
  }

  // --- Resolve Reasoning Effort (#324) ---
  // Priority: session.reasoningEffort → agent.reasoningEffort (builtin) /
  // agent.runtimeConfig.reasoningEffort (external runtime). The snapshot may
  // hold the literal 'default' — that is a meaningful value ("session reverted
  // to default") and must win over a non-default agent value, which the ??
  // chain handles naturally.
  const rawReasoningEffort = sessionMeta?.reasoningEffort
    ?? (resolvedRuntime === 'builtin'
      ? (agent?.reasoningEffort as string | undefined)
      : agentRuntimeConfig?.reasoningEffort);
  const reasoningEffort = resolvedRuntime === 'builtin'
    ? rawReasoningEffort
    : coerceReasoningEffortSettingForRuntime(rawReasoningEffort, resolvedRuntime);
  if (resolvedRuntime !== 'builtin'
      && typeof rawReasoningEffort === 'string'
      && rawReasoningEffort.trim().length > 0
      && rawReasoningEffort.trim() !== 'default'
      && reasoningEffort === undefined) {
    console.warn(
      `[runtime-coerce] dropping stale workspace reasoningEffort='${rawReasoningEffort}' on runtime='${resolvedRuntime}'; falling back to runtime default. sessionId=${sessionMeta?.id ?? '<none>'} agentDir=${agentDir}`,
    );
  }

  // --- Resolve Permission Mode ---
  // Builtin keeps the historical precedence:
  // session snapshot → Agent → Project → global default. External runtimes use
  // only their runtime-specific fields; project/global builtin permission
  // values are not portable.
  let permissionMode: string;
  if (resolvedRuntime === 'builtin') {
    // Deliberate divergence from the renderer's UI fallback (which defaults a
    // missing defaultPermissionMode to 'plan'): headless pre-warm for IM/cron
    // sessions must default to 'auto' (classify, non-blocking), NOT 'plan'
    // (read-only) — defaulting headless sessions to plan would make them refuse
    // every write before the first user message. Only reachable on a brand-new
    // empty config; once the UI has run, config.defaultPermissionMode is set.
    permissionMode = asBuiltinPermissionMode(sessionMeta?.permissionMode)
      ?? asBuiltinPermissionMode(agent?.permissionMode)
      ?? asBuiltinPermissionMode(project?.permissionMode)
      ?? asBuiltinPermissionMode(config.defaultPermissionMode)
      ?? 'auto';
  } else {
    const rawPermissionMode = sessionMeta?.permissionMode ?? agentRuntimeConfig?.permissionMode;
    const coercedPermissionMode = coercePermissionModeForRuntime(rawPermissionMode, resolvedRuntime);
    if (typeof rawPermissionMode === 'string'
        && rawPermissionMode.trim().length > 0
        && coercedPermissionMode === undefined) {
      console.warn(
        `[runtime-coerce] dropping stale workspace permissionMode='${rawPermissionMode}' on runtime='${resolvedRuntime}'; falling back to runtime default. sessionId=${sessionMeta?.id ?? '<none>'} agentDir=${agentDir}`,
      );
    }
    permissionMode = coercedPermissionMode
      ?? getDefaultRuntimePermissionMode(resolvedRuntime)
      ?? 'default';
  }

  // Gate on the signals that indicate a real workspace match — NOT permissionMode,
  // which now always resolves to a non-empty string ('auto' fallback) and would
  // make this log fire on every call (incl. no-match). Stay silent when nothing
  // resolved, as before.
  if (mcpServers.length > 0 || providerEnv || model || agent) {
    const source = sessionMeta?.configSnapshotAt ? 'session-snapshot' : 'agent';
    console.log(
      `[admin-config] resolveWorkspaceConfig (${source}): ` +
      `provider=${providerId ?? 'subscription'}, model=${model ?? 'default'}, ` +
      `permission=${permissionMode}, mcp=${mcpServers.length} server(s)${agent ? '' : ' (no agent match)'}`
    );
  }

  return { mcpServers, providerEnv, model, permissionMode, reasoningEffort };
}
