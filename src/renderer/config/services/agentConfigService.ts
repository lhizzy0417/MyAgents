// Agent config service — CRUD helpers, migration from ImBotConfigs
import type { AppConfig, Project, WorkspaceTemplate, WorkspaceTemplateAgentDefaults } from '../types';
import { getEffectiveModelAliases, PRESET_TEMPLATES } from '../types';
import type { AgentConfig, ChannelConfig, ChannelOverrides } from '../../../shared/types/agent';
import type { ImBotConfig } from '../../../shared/types/im';
import { atomicModifyConfig, loadAppConfig } from './appConfigService';
import { workspacePathsEqual } from '../../../shared/workspacePath';

// ============= Query Helpers =============

export function getAgentById(config: AppConfig, agentId: string): AgentConfig | undefined {
  return config.agents?.find(a => a.id === agentId);
}

export function getChannelById(agent: AgentConfig, channelId: string): ChannelConfig | undefined {
  return agent.channels?.find(c => c.id === channelId);
}

/**
 * Whether a channel has the credentials its runtime needs to start — mirrors the
 * per-type requirements ChannelWizard enforces at creation. Single source of truth
 * for "can this channel be enabled", shared by the detail-view toggle (specific
 * toast) and `startAndEnableAgentChannel` (hard guard). Refusing to enable a
 * credential-less channel prevents persisting `enabled=true` for something
 * `auto_start_all_enabled_agent_channels` would then fail to launch on every boot.
 */
export function channelHasCredentials(ch: ChannelConfig): boolean {
  if (ch.type === 'feishu') return Boolean(ch.feishuAppId && ch.feishuAppSecret);
  if (ch.type === 'dingtalk') return Boolean(ch.dingtalkClientId && ch.dingtalkClientSecret);
  if (ch.type.startsWith('openclaw:')) return Boolean(ch.openclawPluginId);
  return Boolean(ch.botToken);
}

export function getAgentByWorkspacePath(config: AppConfig, workspacePath: string): AgentConfig | undefined {
  // Canonical identity (#320): Agent.workspacePath and the queried path can
  // diverge in separator/case form across stores — match the same way Rust does.
  return config.agents?.find(a => workspacePathsEqual(a.workspacePath, workspacePath));
}

// ============= Agent Creation Helpers =============

export interface BuildAgentForProjectOptions {
  agentId?: string;
  defaultPermissionMode?: string;
  agentDefaults?: WorkspaceTemplateAgentDefaults;
  templates?: readonly WorkspaceTemplate[];
}

function cloneHeartbeatConfig(defaults: WorkspaceTemplateAgentDefaults['heartbeat']) {
  if (!defaults) return undefined;
  return {
    ...defaults,
    activeHours: defaults.activeHours ? { ...defaults.activeHours } : undefined,
  };
}

function cloneMemoryAutoUpdateConfig(defaults: WorkspaceTemplateAgentDefaults['memoryAutoUpdate']) {
  if (!defaults) return undefined;
  return { ...defaults };
}

export function resolveAgentDefaultsForProject(
  project: Project,
  templates: readonly WorkspaceTemplate[] = PRESET_TEMPLATES,
): WorkspaceTemplateAgentDefaults | undefined {
  if (project.templateSource !== 'builtin' || !project.templateId) return undefined;
  return templates.find(t => t.isBuiltin && t.id === project.templateId)?.agentDefaults;
}

export function buildAgentForProject(
  project: Project,
  options: BuildAgentForProjectOptions = {},
): AgentConfig {
  const agentDefaults = options.agentDefaults ?? resolveAgentDefaultsForProject(project, options.templates);
  return {
    id: options.agentId ?? crypto.randomUUID(),
    name: project.displayName || project.name,
    icon: project.icon,
    workspacePath: project.path,
    enabled: agentDefaults?.enabled ?? false,
    channels: [],
    providerId: project.providerId ?? undefined,
    model: project.model ?? undefined,
    permissionMode: project.permissionMode || options.defaultPermissionMode || 'plan',
    mcpEnabledServers: project.mcpEnabledServers,
    heartbeat: cloneHeartbeatConfig(agentDefaults?.heartbeat),
    memoryAutoUpdate: cloneMemoryAutoUpdateConfig(agentDefaults?.memoryAutoUpdate),
  };
}

// ============= Migration: ImBotConfigs → Agents =============

let _agentMigrationDone = false;

/**
 * Migrate legacy imBotConfigs[] to agents[].
 * Trigger: imBotConfigs has entries AND agents is empty/absent.
 * Groups bots by defaultWorkspacePath → same workspace bots become channels of one agent.
 */
export function migrateImBotConfigsToAgents(config: AppConfig, projects: Project[]): AppConfig {
  if (_agentMigrationDone) return config;

  const bots = config.imBotConfigs;
  if (!bots || bots.length === 0) return config;
  if (config.agents && config.agents.length > 0) return config;

  _agentMigrationDone = true;
  console.log(`[agentConfigService] Migrating ${bots.length} ImBotConfig(s) to Agent architecture`);

  // Group bots by workspace path
  const groups = new Map<string, ImBotConfig[]>();
  for (const bot of bots) {
    const key = (bot.defaultWorkspacePath || '__default__').replace(/\\/g, '/');
    const group = groups.get(key) || [];
    group.push(bot);
    groups.set(key, group);
  }

  const agents: AgentConfig[] = [];

  for (const [workspacePath, groupBots] of groups) {
    const primary = groupBots[0];
    const agentId = crypto.randomUUID();
    const resolvedPath = workspacePath === '__default__' ? '' : workspacePath;

    // Build channels from each bot
    const channels: ChannelConfig[] = groupBots.map(bot => {
      // Detect overrides: if bot's AI config differs from primary, store in overrides
      const overrides: ChannelOverrides = {};
      let hasOverrides = false;

      if (bot.providerId !== primary.providerId && bot.providerId !== undefined) {
        overrides.providerId = bot.providerId;
        hasOverrides = true;
      }
      if (bot.providerEnvJson !== primary.providerEnvJson && bot.providerEnvJson !== undefined) {
        overrides.providerEnvJson = bot.providerEnvJson;
        hasOverrides = true;
      }
      if (bot.model !== primary.model && bot.model !== undefined) {
        overrides.model = bot.model;
        hasOverrides = true;
      }
      if (bot.permissionMode !== primary.permissionMode) {
        overrides.permissionMode = bot.permissionMode;
        hasOverrides = true;
      }
      if (bot.groupToolsDeny && bot.groupToolsDeny.length > 0) {
        overrides.toolsDeny = bot.groupToolsDeny;
        hasOverrides = true;
      }

      return {
        id: bot.id, // Reuse bot ID as channel ID for continuity
        type: bot.platform,
        name: bot.name,
        enabled: bot.enabled,
        botToken: bot.botToken || undefined,
        telegramUseDraft: bot.telegramUseDraft,
        feishuAppId: bot.feishuAppId,
        feishuAppSecret: bot.feishuAppSecret,
        dingtalkClientId: bot.dingtalkClientId,
        dingtalkClientSecret: bot.dingtalkClientSecret,
        dingtalkUseAiCard: bot.dingtalkUseAiCard,
        dingtalkCardTemplateId: bot.dingtalkCardTemplateId,
        openclawPluginId: bot.openclawPluginId,
        openclawNpmSpec: bot.openclawNpmSpec,
        openclawPluginConfig: bot.openclawPluginConfig,
        openclawManifest: bot.openclawManifest,
        allowedUsers: bot.allowedUsers,
        groupPermissions: bot.groupPermissions,
        groupActivation: bot.groupActivation,
        overrides: hasOverrides ? overrides : undefined,
        setupCompleted: bot.setupCompleted,
      } satisfies ChannelConfig;
    });

    const agent: AgentConfig = {
      id: agentId,
      name: primary.name || `Agent (${resolvedPath.split('/').pop() || 'default'})`,
      enabled: groupBots.some(b => b.enabled),
      workspacePath: resolvedPath,
      providerId: primary.providerId,
      model: primary.model,
      providerEnvJson: primary.providerEnvJson,
      permissionMode: primary.permissionMode,
      mcpEnabledServers: primary.mcpEnabledServers,
      heartbeat: primary.heartbeat,
      channels,
      setupCompleted: primary.setupCompleted,
    };

    agents.push(agent);

    // Mark corresponding project as agent
    const project = projects.find(p => workspacePathsEqual(p.path, resolvedPath));
    if (project) {
      project.isAgent = true;
      project.agentId = agentId;
    }
  }

  config.agents = agents;
  // Keep imBotConfigs as empty array to prevent re-migration
  config.imBotConfigs = [];

  console.log(`[agentConfigService] Migration complete: ${agents.length} agent(s) with ${bots.length} channel(s) total`);
  return config;
}

// ============= BasicAgent Auto-Creation (v0.1.49) =============

/**
 * Ensure every Project has a linked AgentConfig (basicAgent).
 * Runs at startup after migrateImBotConfigsToAgents().
 *
 * - Projects without agentId → create basicAgent with AI fields copied from Project
 * - Projects with agentId but orphaned (agent deleted) → recreate basicAgent
 * - Projects already linked to a valid agent → skip
 *
 * Returns { changed } so caller can decide whether to persist.
 */
export function ensureAllProjectsHaveAgent(
  config: AppConfig,
  projects: Project[],
  defaultPermissionMode?: string,
): { changed: boolean } {
  const agents = config.agents ?? [];
  const agentMap = new Map(agents.map(a => [a.id, a]));
  let changed = false;
  let createdCount = 0;

  for (const project of projects) {
    // Skip if already linked to a valid agent
    if (project.agentId && agentMap.has(project.agentId)) {
      continue;
    }

    // Also check by workspacePath (agent exists but project.agentId is stale/missing)
    const existingByPath = agents.find(a => workspacePathsEqual(a.workspacePath, project.path));
    if (existingByPath) {
      // Fix orphaned reference
      project.agentId = existingByPath.id;
      if (existingByPath.enabled) {
        project.isAgent = true;
      }
      changed = true;
      continue;
    }

    // Create basicAgent — AI fields from Project (fallback to defaults)
    const basicAgent = buildAgentForProject(project, { defaultPermissionMode });

    agents.push(basicAgent);
    agentMap.set(basicAgent.id, basicAgent);
    project.agentId = basicAgent.id;
    if (basicAgent.enabled) {
      project.isAgent = true;
    }
    changed = true;
    createdCount++;
  }

  if (changed) {
    config.agents = agents;
    console.log(`[agentConfigService] ensureAllProjectsHaveAgent: created ${createdCount} basicAgent(s), total agents: ${agents.length}`);
  }

  return { changed };
}

// ============= Persistence Helpers =============

/**
 * Save agents to disk (atomic read-modify-write).
 */
export async function persistAgents(agents: AgentConfig[]): Promise<void> {
  await atomicModifyConfig(config => ({
    ...config,
    agents,
  }));
}

/**
 * Patch a single agent's config (atomic read-modify-write).
 * After disk write, hot-reloads runtime state of running agent instances via Tauri command.
 */
export async function patchAgentConfig(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
): Promise<AgentConfig | undefined> {
  let updated: AgentConfig | undefined;

  // If mcpEnabledServers changed, resolve mcpServersJson before disk write
  // so both fields are persisted atomically in a single transaction
  let resolvedMcpJson: string | undefined;
  if ('mcpEnabledServers' in patch) {
    try {
      const { getAllMcpServers, getEnabledMcpServerIds } = await import('@/config/configService');
      const allServers = await getAllMcpServers();
      const globalEnabled = await getEnabledMcpServerIds();
      const agentMcpIds = patch.mcpEnabledServers ?? [];
      const enabledMcpDefs = allServers.filter(
        s => globalEnabled.includes(s.id) && agentMcpIds.includes(s.id),
      );
      resolvedMcpJson = enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : undefined;
    } catch (e) {
      console.warn('[agentConfigService] Failed to resolve MCP servers:', e);
    }
  }

  // If providerId changed but providerEnvJson was NOT explicitly provided,
  // auto-resolve from provider registry + stored API keys.
  // This is the "pit of success" pattern: callers only need to set providerId,
  // credentials are resolved centrally so IM Bot / CronTask always get correct provider env.
  let resolvedProviderEnvJson: string | undefined | null;
  let shouldUpdateProviderEnv = false;
  if ('providerId' in patch && !('providerEnvJson' in patch)) {
    shouldUpdateProviderEnv = true;
    try {
      const { getAllProviders, loadApiKeys } = await import('./providerService');
      const [allProviders, apiKeys] = await Promise.all([getAllProviders(), loadApiKeys()]);
      const provider = allProviders.find(p => p.id === patch.providerId);
      if (provider && provider.type !== 'subscription') {
        // Load config to get user's providerModelAliases overrides
        const latestConfig = await loadAppConfig();
        const aliases = getEffectiveModelAliases(provider, latestConfig.providerModelAliases);
        resolvedProviderEnvJson = JSON.stringify({
          providerId: provider.id,
          baseUrl: provider.config.baseUrl,
          apiKey: apiKeys[provider.id],
          authType: provider.authType,
          apiProtocol: provider.apiProtocol,
          maxOutputTokens: provider.maxOutputTokens,
          maxOutputTokensParamName: provider.maxOutputTokensParamName,
          upstreamFormat: provider.upstreamFormat,
          ...(aliases ? { modelAliases: aliases } : {}),
        });
      } else {
        // Subscription provider (e.g. Anthropic) or unknown — clear providerEnvJson
        resolvedProviderEnvJson = undefined;
      }
    } catch (e) {
      console.warn('[agentConfigService] Failed to resolve provider env:', e);
      shouldUpdateProviderEnv = false;
    }
  }

  await atomicModifyConfig(config => {
    const agents = [...(config.agents || [])];
    const idx = agents.findIndex(a => a.id === agentId);
    if (idx < 0) return config;
    agents[idx] = {
      ...agents[idx],
      ...patch,
      id: agentId,
      // Persist resolved MCP JSON alongside mcpEnabledServers
      ...(resolvedMcpJson !== undefined || 'mcpEnabledServers' in patch
        ? { mcpServersJson: resolvedMcpJson }
        : {}),
      // Persist resolved provider env alongside providerId
      ...(shouldUpdateProviderEnv
        ? { providerEnvJson: resolvedProviderEnvJson ?? undefined }
        : {}),
    };
    updated = agents[idx];
    return {
      ...config,
      agents,
    };
  });

  // Hot-reload runtime state if any runtime-sensitive field changed
  if (updated) {
    // If providerEnvJson was auto-resolved (not in original patch), inject it
    // so syncAgentRuntime pushes the new credentials to the running agent
    const effectivePatch = shouldUpdateProviderEnv
      ? { ...patch, providerEnvJson: resolvedProviderEnvJson ?? undefined }
      : patch;
    await syncAgentRuntime(agentId, effectivePatch, updated, resolvedMcpJson);
  }

  return updated;
}

/**
 * Sync runtime-sensitive fields to running agent instance via Tauri command.
 * Only sends fields that are present in the patch (i.e. actually changed).
 */
async function syncAgentRuntime(
  agentId: string,
  patch: Partial<Omit<AgentConfig, 'id'>>,
  _updatedAgent: AgentConfig,
  preResolvedMcpJson?: string,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  // Build a runtime patch with only the fields that changed
  const runtimePatch: Record<string, unknown> = {};
  let hasRuntimeChanges = false;

  if ('model' in patch) {
    runtimePatch.model = patch.model ?? null;
    hasRuntimeChanges = true;
  }
  if ('providerEnvJson' in patch) {
    runtimePatch.providerEnvJson = patch.providerEnvJson ?? null;
    hasRuntimeChanges = true;
  }
  if ('permissionMode' in patch) {
    runtimePatch.permissionMode = patch.permissionMode ?? null;
    hasRuntimeChanges = true;
  }
  if ('runtime' in patch) {
    runtimePatch.runtime = patch.runtime ?? null;
    hasRuntimeChanges = true;
  }
  if ('runtimeConfig' in patch) {
    runtimePatch.runtimeConfig = patch.runtimeConfig ?? null;
    hasRuntimeChanges = true;
  }
  if ('heartbeat' in patch) {
    runtimePatch.heartbeatConfigJson = patch.heartbeat ? JSON.stringify(patch.heartbeat) : null;
    hasRuntimeChanges = true;
  }
  if ('memoryAutoUpdate' in patch) {
    runtimePatch.memoryAutoUpdateConfigJson = patch.memoryAutoUpdate ? JSON.stringify(patch.memoryAutoUpdate) : null;
    hasRuntimeChanges = true;
  }

  // mcpEnabledServers changed → use pre-resolved JSON (already persisted to disk atomically)
  if ('mcpEnabledServers' in patch) {
    runtimePatch.mcpServersJson = preResolvedMcpJson ?? null;
    hasRuntimeChanges = true;
  }
  // channels changed → forward to Rust for per-channel hot-reload (groupActivation etc.)
  if ('channels' in patch && patch.channels) {
    runtimePatch.channels = patch.channels;
    hasRuntimeChanges = true;
  }

  if (!hasRuntimeChanges) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cmd_update_agent_config', { agentId, patch: runtimePatch });
  } catch (e) {
    // Agent may not be running — that's fine, config is already persisted to disk
    console.debug('[agentConfigService] Runtime sync skipped (agent not running?):', e);
  }
}

/**
 * Add a new agent config to disk.
 */
export async function addAgentConfig(agent: AgentConfig): Promise<void> {
  await atomicModifyConfig(config => {
    const agents = [...(config.agents || []), agent];
    return {
      ...config,
      agents,
    };
  });
}

/**
 * Remove an agent config from disk.
 */
export async function removeAgentConfig(agentId: string): Promise<void> {
  await atomicModifyConfig(config => {
    const agents = (config.agents || []).filter(a => a.id !== agentId);
    return {
      ...config,
      agents,
    };
  });
}

// ============= Runtime Helpers =============

/**
 * Start an agent channel via Tauri command.
 * Resolves MCP server definitions and effective config (agent + channel overrides).
 */
export async function invokeStartAgentChannel(
  agent: AgentConfig,
  channel: ChannelConfig,
): Promise<void> {
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (!isTauriEnvironment()) return;

  const { invoke } = await import('@tauri-apps/api/core');
  const { getAllMcpServers, getEnabledMcpServerIds } = await import('@/config/configService');
  const { resolveEffectiveConfig } = await import('../../../shared/types/agent');

  // Resolve MCP server definitions
  const allServers = await getAllMcpServers();
  const globalEnabled = await getEnabledMcpServerIds();
  const agentMcpIds = agent.mcpEnabledServers ?? [];
  const enabledMcpDefs = allServers.filter(
    s => globalEnabled.includes(s.id) && agentMcpIds.includes(s.id),
  );

  // Resolve effective config (agent defaults + channel overrides)
  const effective = resolveEffectiveConfig(agent, channel);

  await invoke('cmd_start_agent_channel', {
    agentId: agent.id,
    channelId: channel.id,
    agentConfig: {
      id: agent.id,
      name: agent.name,
      enabled: agent.enabled,
      workspacePath: agent.workspacePath,
      providerId: effective.providerId,
      model: effective.model,
      providerEnvJson: effective.providerEnvJson,
      permissionMode: effective.permissionMode,
      runtime: effective.runtime,
      runtimeConfig: effective.runtimeConfig,
      mcpEnabledServers: agent.mcpEnabledServers,
      mcpServersJson: enabledMcpDefs.length > 0 ? JSON.stringify(enabledMcpDefs) : null,
      heartbeat: agent.heartbeat,
      memoryAutoUpdate: agent.memoryAutoUpdate,
      channels: [],
      lastActiveChannel: agent.lastActiveChannel,
    },
    channelConfig: {
      id: channel.id,
      type: channel.type,
      name: channel.name,
      enabled: channel.enabled,
      botToken: channel.botToken,
      telegramUseDraft: channel.telegramUseDraft,
      feishuAppId: channel.feishuAppId,
      feishuAppSecret: channel.feishuAppSecret,
      dingtalkClientId: channel.dingtalkClientId,
      dingtalkClientSecret: channel.dingtalkClientSecret,
      dingtalkUseAiCard: channel.dingtalkUseAiCard,
      dingtalkCardTemplateId: channel.dingtalkCardTemplateId,
      openclawPluginId: channel.openclawPluginId,
      openclawNpmSpec: channel.openclawNpmSpec,
      openclawPluginConfig: channel.openclawPluginConfig,
      openclawManifest: channel.openclawManifest,
      openclawEnabledToolGroups: channel.openclawEnabledToolGroups,
      allowedUsers: channel.allowedUsers || [],
      groupPermissions: channel.groupPermissions || [],
      groupActivation: channel.groupActivation,
      overrides: channel.overrides,
      setupCompleted: channel.setupCompleted,
    },
  });
}

/**
 * Stop a running agent channel AND persist `channel.enabled = false` so the
 * channel stays stopped across app restarts (issue #219).
 *
 * Paired with `startAndEnableAgentChannel` — these two are the "user-initiated
 * lifecycle" operations. They MUST be symmetric: start flips enabled to true,
 * stop flips it to false. Otherwise auto_start_all_enabled_agent_channels in
 * the Rust layer re-launches a channel the user explicitly stopped (or worse,
 * leaves a re-enabled channel un-runnable).
 *
 * DO NOT use this for:
 *  - Transient stop+restart (e.g. credential refresh) — call cmd_stop_agent_channel
 *    + invokeStartAgentChannel directly, keep enabled untouched
 *  - Channel deletion — remove from channels[] in a patchAgentConfig call
 *  - Agent-level disable — patch `agent.enabled = false`; the Rust
 *    auto_start_all_enabled_agent_channels gate handles per-channel rollup
 *
 * Implementation notes (review-by-codex v1 → v2):
 *  - Takes IDs (not an `agent` snapshot) so concurrent channel additions /
 *    credential writes / name syncs aren't clobbered by a stale whole-array
 *    patch (codex F1 against the v1 helper).
 *  - Mutates inside `atomicModifyConfig` against the freshest on-disk config,
 *    not the caller's React prop. Throws if the agent or channel disappeared
 *    between click and persist (was a silent no-op in v1).
 *  - Persists BEFORE the runtime stop: if the process crashes between persist
 *    and runtime stop, restart sees enabled=false and won't auto-launch. The
 *    inverse order would silently re-launch a stopped channel on the next boot.
 *  - Runtime stop is best-effort: channel may already be down or sidecar gone;
 *    the persisted enabled=false is what makes the stop survive restarts.
 */
export async function stopAndDisableAgentChannel(
  agentId: string,
  channelId: string,
): Promise<void> {
  const { atomicModifyConfig } = await import('@/config/services/appConfigService');
  await atomicModifyConfig(config => {
    const agents = [...(config.agents ?? [])];
    const aIdx = agents.findIndex(a => a.id === agentId);
    if (aIdx < 0) {
      throw new Error(`stopAndDisableAgentChannel: agent ${agentId} not found in config`);
    }
    const channels = [...(agents[aIdx].channels ?? [])];
    const cIdx = channels.findIndex(c => c.id === channelId);
    if (cIdx < 0) {
      throw new Error(`stopAndDisableAgentChannel: channel ${channelId} not found in agent ${agentId}`);
    }
    if (channels[cIdx].enabled === false) {
      // Already disabled (e.g. re-click after a failed runtime stop). atomicModifyConfig
      // short-circuits the disk write when before === after — idempotent by design.
      return config;
    }
    channels[cIdx] = { ...channels[cIdx], enabled: false };
    agents[aIdx] = { ...agents[aIdx], channels };
    return { ...config, agents };
  });
  const { isTauriEnvironment } = await import('@/utils/browserMock');
  if (isTauriEnvironment()) {
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      await invoke('cmd_stop_agent_channel', { agentId, channelId });
    } catch (e) {
      // Channel may already be stopped or sidecar lost. Persistence above already
      // landed, so the next restart respects the user's intent.
      console.warn('[agentConfigService] cmd_stop_agent_channel failed (enabled=false already persisted):', e);
    }
  }
}

/**
 * Symmetric counterpart to `stopAndDisableAgentChannel`: persist
 * `channel.enabled = true` against the latest on-disk config, then start the
 * runtime instance using a fresh snapshot.
 *
 * Why both helpers exist (v2 of #219): the channel-list UI greys out the
 * start button when `channel.enabled` is false. Before this helper, list-view's
 * "start" only invoked the runtime; if the user had previously disabled the
 * channel, the button was greyed and they couldn't restart from the list at
 * all — forced to navigate to the channel detail view. With this helper +
 * removing the disabled gate, both list and detail can fully re-enable.
 *
 * Returns the fresh `(agent, channel)` snapshot that was actually written, so
 * the caller doesn't depend on a separate read-back race.
 */
export async function startAndEnableAgentChannel(
  agentId: string,
  channelId: string,
): Promise<void> {
  const { atomicModifyConfig } = await import('@/config/services/appConfigService');
  const updatedConfig = await atomicModifyConfig(config => {
    const agents = [...(config.agents ?? [])];
    const aIdx = agents.findIndex(a => a.id === agentId);
    if (aIdx < 0) {
      throw new Error(`startAndEnableAgentChannel: agent ${agentId} not found in config`);
    }
    const channels = [...(agents[aIdx].channels ?? [])];
    const cIdx = channels.findIndex(c => c.id === channelId);
    if (cIdx < 0) {
      throw new Error(`startAndEnableAgentChannel: channel ${channelId} not found in agent ${agentId}`);
    }
    if (channels[cIdx].enabled === true) {
      // Already enabled — atomicModifyConfig will skip the write.
      return config;
    }
    // Refuse to enable a credential-less channel: persisting enabled=true here
    // would make auto_start_all_enabled_agent_channels retry an unstartable
    // channel on every boot. The detail-view path checks this first (and shows a
    // specific toast); this guard also covers the list-view start button, which
    // has no precheck (issue #219 review).
    if (!channelHasCredentials(channels[cIdx])) {
      throw new Error(`startAndEnableAgentChannel: channel ${channelId} is missing required credentials`);
    }
    channels[cIdx] = { ...channels[cIdx], enabled: true };
    agents[aIdx] = { ...agents[aIdx], channels };
    return { ...config, agents };
  });
  // Re-read the freshly-written snapshot for invokeStartAgentChannel. Reading
  // from updatedConfig (return value of atomicModifyConfig) instead of looking
  // up again on disk keeps the start-time view consistent with what we just
  // persisted — even if another writer lands between persist and start.
  const freshAgent = updatedConfig.agents?.find(a => a.id === agentId);
  const freshChannel = freshAgent?.channels?.find(c => c.id === channelId);
  if (!freshAgent || !freshChannel) {
    // Shouldn't happen — modifier above throws on missing — but guard explicitly
    // so the runtime invoke doesn't get garbage.
    throw new Error(`startAndEnableAgentChannel: post-persist read of ${agentId}/${channelId} returned nothing`);
  }
  await invokeStartAgentChannel(freshAgent, freshChannel);
}
