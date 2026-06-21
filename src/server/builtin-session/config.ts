import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';
import type { BackgroundAgentPermissionMode, McpServerDefinition } from '../../shared/config-types';
import { DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE } from '../utils/background-agent-permission';
import type { BuiltinConfigSnapshot, BuiltinRestartReason, PermissionMode, ProviderEnv } from './types';

const pendingConfigRestart = new Set<BuiltinRestartReason>();
let currentMcpServers: McpServerDefinition[] | null = null;
let frozenSdkMcpFingerprint = '';
let currentEnabledPluginIds: string[] | null = null;
let currentAgentDefinitions: Record<string, AgentDefinition> | null = null;
let currentPermissionMode: PermissionMode = 'auto';
let prePlanPermissionMode: PermissionMode | null = null;
let currentBackgroundAgentPermissionMode: BackgroundAgentPermissionMode = DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE;
let currentModel: string | undefined = undefined;
let currentReasoningEffort: string | undefined = undefined;
let currentProviderEnv: ProviderEnv | undefined = undefined;
let pendingProviderHistoryBoundaryReset = false;

export const configState = {
  get currentMcpServers(): McpServerDefinition[] | null {
    return currentMcpServers;
  },
  set currentMcpServers(servers: McpServerDefinition[] | null) {
    currentMcpServers = servers;
  },
  get frozenSdkMcpFingerprint(): string {
    return frozenSdkMcpFingerprint;
  },
  set frozenSdkMcpFingerprint(fingerprint: string) {
    frozenSdkMcpFingerprint = fingerprint;
  },
  get currentEnabledPluginIds(): string[] | null {
    return currentEnabledPluginIds;
  },
  set currentEnabledPluginIds(ids: string[] | null) {
    currentEnabledPluginIds = ids;
  },
  get currentAgentDefinitions(): Record<string, AgentDefinition> | null {
    return currentAgentDefinitions;
  },
  set currentAgentDefinitions(agents: Record<string, AgentDefinition> | null) {
    currentAgentDefinitions = agents;
  },
  get currentPermissionMode(): PermissionMode {
    return currentPermissionMode;
  },
  set currentPermissionMode(mode: PermissionMode) {
    currentPermissionMode = mode;
  },
  get prePlanPermissionMode(): PermissionMode | null {
    return prePlanPermissionMode;
  },
  set prePlanPermissionMode(mode: PermissionMode | null) {
    prePlanPermissionMode = mode;
  },
  get currentBackgroundAgentPermissionMode(): BackgroundAgentPermissionMode {
    return currentBackgroundAgentPermissionMode;
  },
  set currentBackgroundAgentPermissionMode(mode: BackgroundAgentPermissionMode) {
    currentBackgroundAgentPermissionMode = mode;
  },
  get currentModel(): string | undefined {
    return currentModel;
  },
  set currentModel(model: string | undefined) {
    currentModel = model;
  },
  get currentReasoningEffort(): string | undefined {
    return currentReasoningEffort;
  },
  set currentReasoningEffort(value: string | undefined) {
    currentReasoningEffort = value;
  },
  get currentProviderEnv(): ProviderEnv | undefined {
    return currentProviderEnv;
  },
  set currentProviderEnv(providerEnv: ProviderEnv | undefined) {
    currentProviderEnv = providerEnv;
  },
  get pendingProviderHistoryBoundaryReset(): boolean {
    return pendingProviderHistoryBoundaryReset;
  },
  set pendingProviderHistoryBoundaryReset(value: boolean) {
    pendingProviderHistoryBoundaryReset = value;
  },
};

export function scheduleDeferredRestart(reason: BuiltinRestartReason): void {
  pendingConfigRestart.add(reason);
}

export function hasDeferredRestart(): boolean {
  return pendingConfigRestart.size > 0;
}

export function drainDeferredRestart(): string {
  if (pendingConfigRestart.size === 0) return '';
  const reasons = [...pendingConfigRestart].join(',');
  pendingConfigRestart.clear();
  return reasons;
}

export function clearDeferredRestart(): void {
  pendingConfigRestart.clear();
}

export function getCurrentMcpServers(): readonly McpServerDefinition[] | null {
  return currentMcpServers;
}

export function setCurrentMcpServers(servers: McpServerDefinition[] | null): void {
  currentMcpServers = servers;
}

export function getFrozenSdkMcpFingerprint(): string {
  return frozenSdkMcpFingerprint;
}

export function setFrozenSdkMcpFingerprint(fingerprint: string): void {
  frozenSdkMcpFingerprint = fingerprint;
}

export function getSessionEnabledPluginIds(): readonly string[] | null {
  return currentEnabledPluginIds;
}

export function setSessionEnabledPluginIds(ids: string[] | null): void {
  currentEnabledPluginIds = ids === null ? null : [...ids];
}

export function getCurrentAgentDefinitions(): Record<string, AgentDefinition> | null {
  return currentAgentDefinitions;
}

export function setCurrentAgentDefinitions(agents: Record<string, AgentDefinition> | null): void {
  currentAgentDefinitions = agents;
}

export function getPermissionMode(): PermissionMode {
  return currentPermissionMode;
}

export function setPermissionMode(mode: PermissionMode): void {
  currentPermissionMode = mode;
}

export function getPrePlanPermissionMode(): PermissionMode | null {
  return prePlanPermissionMode;
}

export function setPrePlanPermissionMode(mode: PermissionMode | null): void {
  prePlanPermissionMode = mode;
}

export function setPermissionPlanState(state: {
  permissionMode: PermissionMode;
  prePlanPermissionMode: PermissionMode | null;
}): void {
  currentPermissionMode = state.permissionMode;
  prePlanPermissionMode = state.prePlanPermissionMode;
}

export function getBackgroundAgentPermissionMode(): BackgroundAgentPermissionMode {
  return currentBackgroundAgentPermissionMode;
}

export function setBackgroundAgentPermissionMode(mode: BackgroundAgentPermissionMode): void {
  currentBackgroundAgentPermissionMode = mode;
}

export function getModel(): string | undefined {
  return currentModel;
}

export function setModel(model: string | undefined): void {
  currentModel = model;
}

export function getReasoningEffort(): string | undefined {
  return currentReasoningEffort;
}

export function setReasoningEffort(value: string | undefined): void {
  currentReasoningEffort = value;
}

export function getProviderEnv(): ProviderEnv | undefined {
  return currentProviderEnv;
}

export function setProviderEnv(providerEnv: ProviderEnv | undefined): void {
  currentProviderEnv = providerEnv;
}

export function hasPendingProviderHistoryBoundaryReset(): boolean {
  return pendingProviderHistoryBoundaryReset;
}

export function setPendingProviderHistoryBoundaryReset(value: boolean): void {
  pendingProviderHistoryBoundaryReset = value;
}

export function consumePendingProviderHistoryBoundaryReset(): boolean {
  const value = pendingProviderHistoryBoundaryReset;
  pendingProviderHistoryBoundaryReset = false;
  return value;
}

export function snapshotConfig(): BuiltinConfigSnapshot {
  return {
    mcpServers: currentMcpServers ? [...currentMcpServers] : null,
    enabledPluginIds: currentEnabledPluginIds ? [...currentEnabledPluginIds] : null,
    agentDefinitions: currentAgentDefinitions,
    permissionMode: currentPermissionMode,
    prePlanPermissionMode,
    backgroundAgentPermissionMode: currentBackgroundAgentPermissionMode,
    model: currentModel,
    reasoningEffort: currentReasoningEffort,
    providerEnv: currentProviderEnv,
    pendingProviderHistoryBoundaryReset,
    frozenSdkMcpFingerprint,
    deferredRestartReasons: [...pendingConfigRestart],
  };
}

export function resetConfigForTest(): void {
  pendingConfigRestart.clear();
  currentMcpServers = null;
  frozenSdkMcpFingerprint = '';
  currentEnabledPluginIds = null;
  currentAgentDefinitions = null;
  currentPermissionMode = 'auto';
  prePlanPermissionMode = null;
  currentBackgroundAgentPermissionMode = DEFAULT_BACKGROUND_AGENT_PERMISSION_MODE;
  currentModel = undefined;
  currentReasoningEffort = undefined;
  currentProviderEnv = undefined;
  pendingProviderHistoryBoundaryReset = false;
}
