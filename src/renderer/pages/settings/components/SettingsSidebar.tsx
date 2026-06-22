import type { Dispatch, SetStateAction } from 'react';

import type { SettingsSection } from '../settingsSections';

interface SettingsSidebarProps {
  activeSection: SettingsSection;
  setActiveSection: Dispatch<SetStateAction<SettingsSection>>;
  showDevTools?: boolean;
  floatingBallDevGate?: boolean;
  onShowLogs: () => void;
}

const NAV_ITEMS: Array<{ section: SettingsSection; label: string; activeSections?: SettingsSection[] }> = [
  { section: 'providers', label: '模型供应商' },
  { section: 'skills', label: '技能 Skills', activeSections: ['skills', 'sub-agents'] },
  { section: 'plugins', label: '插件 Plugins' },
  { section: 'mcp', label: '工具箱' },
  { section: 'agent', label: '聊天机器人 Bot' },
  { section: 'desktop-pet', label: '桌面宠物' },
  { section: 'usage-stats', label: '使用统计' },
  { section: 'general', label: '通用设置' },
  { section: 'shortcuts', label: '快捷键' },
  { section: 'about', label: '关于&反馈' },
];

export function SettingsSidebar({
  activeSection,
  setActiveSection,
  showDevTools,
  floatingBallDevGate,
  onShowLogs,
}: SettingsSidebarProps) {
  return (
    <div className="settings-sidebar w-52 shrink-0 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-[var(--ink)]">设置</h1>
        {showDevTools && (
          <button
            onClick={onShowLogs}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="查看 Rust 日志"
          >
            Logs
          </button>
        )}
      </div>

      <nav className="settings-nav space-y-1">
        {NAV_ITEMS.map((item) => {
          if (item.section === 'desktop-pet' && !floatingBallDevGate) return null;
          const activeSections = item.activeSections ?? [item.section];
          const isActive = activeSections.includes(activeSection);
          return (
            <button
              key={item.section}
              onClick={() => setActiveSection(item.section)}
              className={`w-full rounded-lg px-3 py-2.5 text-left text-base font-medium transition-colors ${
                isActive
                  ? 'settings-nav-active bg-[var(--hover-bg)] text-[var(--ink)]'
                  : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
