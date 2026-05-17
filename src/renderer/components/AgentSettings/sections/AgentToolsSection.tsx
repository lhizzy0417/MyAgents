// Agent tools section — MCP server toggles + Claude plugin toggles (PRD 0.2.17)
import { useState, useCallback, useEffect } from 'react';
import type { AgentConfig } from '../../../../shared/types/agent';
import type { PluginEntry } from '../../../../shared/types/plugin';
import { patchAgentConfig } from '@/config/services/agentConfigService';
import { getAllMcpServers, getEnabledMcpServerIds, loadAppConfig } from '@/config/configService';
import type { McpServerDefinition } from '@/config/types';
import McpToolsCard from '../../ImSettings/components/McpToolsCard';

interface AgentToolsSectionProps {
  agent: AgentConfig;
  onAgentChanged: () => void;
}

export default function AgentToolsSection({ agent, onAgentChanged }: AgentToolsSectionProps) {
  const [allServers, setAllServers] = useState<McpServerDefinition[]>([]);
  const [globalEnabled, setGlobalEnabled] = useState<string[]>([]);

  // PRD 0.2.17 — globally-visible Claude plugins (AppConfig.enabledPlugins
  // gate is ON for these). Same two-layer pattern as MCP: this Agent
  // selects a subset of the globally-visible pool.
  const [visiblePlugins, setVisiblePlugins] = useState<PluginEntry[]>([]);

  useEffect(() => {
    void (async () => {
      const [servers, enabled, appConfig] = await Promise.all([
        getAllMcpServers(),
        getEnabledMcpServerIds(),
        loadAppConfig(),
      ]);
      setAllServers(servers);
      setGlobalEnabled(enabled);
      setVisiblePlugins(
        (appConfig.plugins ?? []).filter(p => appConfig.enabledPlugins?.[p.id] === true),
      );
    })();
  }, []);

  // Only show globally-enabled MCP servers
  const availableServers = allServers.filter(s => globalEnabled.includes(s.id));

  const handleToggle = useCallback(async (serverId: string) => {
    const current = agent.mcpEnabledServers || [];
    const newEnabled = current.includes(serverId)
      ? current.filter(id => id !== serverId)
      : [...current, serverId];
    await patchAgentConfig(agent.id, { mcpEnabledServers: newEnabled });
    onAgentChanged();
  }, [agent.id, agent.mcpEnabledServers, onAgentChanged]);

  const handlePluginToggle = useCallback(async (pluginId: string) => {
    const current = agent.enabledPluginIds || [];
    const newEnabled = current.includes(pluginId)
      ? current.filter(id => id !== pluginId)
      : [...current, pluginId];
    await patchAgentConfig(agent.id, { enabledPluginIds: newEnabled });
    onAgentChanged();
  }, [agent.id, agent.enabledPluginIds, onAgentChanged]);

  return (
    <div className="space-y-4">
      <McpToolsCard
        availableMcpServers={availableServers}
        enabledServerIds={agent.mcpEnabledServers || []}
        onToggle={handleToggle}
      />
      {/* PRD 0.2.17 — Plugins. Reuses McpToolsCard component visually
       *  (same card style) by passing plugin records shaped as
       *  McpServerDefinition. Skip rendering entirely when zero plugins
       *  are globally visible — keeps the panel clean for users without
       *  installed plugins. */}
      {visiblePlugins.length > 0 && (
        <McpToolsCard
          title="插件 Plugins"
          subtitle="选择此 Agent 启动会话时自动启用的 Claude 插件（来自 Settings → 插件 中已显示的候选）"
          availableMcpServers={visiblePlugins.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
          })) as McpServerDefinition[]}
          enabledServerIds={agent.enabledPluginIds || []}
          onToggle={handlePluginToggle}
        />
      )}
    </div>
  );
}
