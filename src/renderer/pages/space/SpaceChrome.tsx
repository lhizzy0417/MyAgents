import { useState } from 'react';
import { Bot, ChevronDown, Loader2, LogIn, LogOut, MessageSquare, Package, User } from 'lucide-react';

import type { SpaceSession } from '@/api/spaceCloud';
import myagentsWebLogo from '@/assets/brand/myagents-web-logo.png';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { PAPER_GRID_STYLE } from './spaceUi';

export type SpaceViewMode = 'issues' | 'skills' | 'agents';

function roleLabel(role: string): string {
  if (role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  return 'member';
}

export function SpaceLogin({
  authBusy,
  authFlow,
  onLogin,
}: {
  authBusy: boolean;
  authFlow: { token: string; expiresAt: number } | null;
  onLogin: () => void;
}) {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden bg-[var(--paper)] px-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40" style={PAPER_GRID_STYLE} />
      <div className="relative z-10 w-full max-w-md rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-md">
        <div className="mb-6 flex items-center gap-3">
          <img src={myagentsWebLogo} alt="" className="h-11 w-11 rounded-xl shadow-sm" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--accent-warm)]">Official Space</p>
            <h1 className="truncate text-xl font-semibold text-[var(--ink)]">MyAgents 社区</h1>
            <p className="text-sm text-[var(--ink-muted)]">使用 Google 账号进入官方 Space</p>
          </div>
        </div>
        <button
          type="button"
          disabled={authBusy}
          onClick={onLogin}
          className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
        >
          {authBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {authFlow ? '等待浏览器授权完成' : '继续使用 Google'}
        </button>
        <p className="mt-3 text-center text-xs text-[var(--ink-muted)]">授权完成后会自动回到 MyAgents。</p>
      </div>
    </div>
  );
}

export function SpaceSidebar({
  session,
  mode,
  issueCount,
  skillCount,
  agentCount,
  onSpaceTabChange,
  onLogout,
}: {
  session: SpaceSession;
  mode: SpaceViewMode;
  issueCount: number;
  skillCount: number;
  agentCount: number;
  onSpaceTabChange: (mode: SpaceViewMode) => void;
  onLogout: () => void;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  useCloseLayer(() => {
    if (!accountMenuOpen) return false;
    setAccountMenuOpen(false);
    return true;
  }, 20);

  const communityItems: Array<{ mode: SpaceViewMode; label: string; count?: number; icon: typeof MessageSquare }> = [
    { mode: 'issues', label: 'Issues', count: issueCount, icon: MessageSquare },
    { mode: 'skills', label: 'Skills', count: skillCount, icon: Package },
    { mode: 'agents', label: 'Agents', count: agentCount, icon: Bot },
  ];

  return (
    <aside className="grid w-80 shrink-0 grid-rows-[minmax(0,1fr)_auto] gap-3.5 border-r border-[var(--line)] bg-[var(--paper)]/70 p-3.5">
      <div className="min-h-0 overflow-y-auto">
        <details className="group/space mb-2.5 border-b border-[var(--line-subtle)] pb-2.5" open>
          <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-elevated)]/70 [&::-webkit-details-marker]:hidden">
            <img src={myagentsWebLogo} alt="" className="h-9 w-9 rounded-xl shadow-sm" />
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <strong className="truncate text-base font-semibold text-[var(--ink)]">{session.space.name}</strong>
                <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold lowercase text-[var(--ink-muted)]">
                  {roleLabel(session.membership.role)}
                </span>
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-xs font-medium text-[var(--ink-muted)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)] ring-4 ring-[var(--success-bg)]" />
                <span>Official Space</span>
                <span>开放加入</span>
              </span>
            </span>
            <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--ink-muted)] transition-transform group-open/space:rotate-0" />
          </summary>
          <nav className="grid gap-1 pt-1 pl-6" aria-label={session.space.name}>
            {communityItems.map((item) => {
              const Icon = item.icon;
              const selected = mode === item.mode;
              return (
                <button
                  key={item.mode}
                  type="button"
                  onClick={() => onSpaceTabChange(item.mode)}
                  className={`grid min-h-9 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2.5 text-left text-sm font-semibold transition-colors ${
                    selected
                      ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                      : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                  {typeof item.count === 'number' && (
                    <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{item.count}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </details>
      </div>

      <div className="relative border-t border-[var(--line-subtle)] pt-3">
        <button
          type="button"
          onClick={() => setAccountMenuOpen((value) => !value)}
          aria-expanded={accountMenuOpen}
          className="flex h-10 w-full items-center gap-2 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/60 px-3 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
        >
          <User className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{session.user.email}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        </button>
        <div
          className={`absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 p-2 shadow-md backdrop-blur-md transition-all ${
            accountMenuOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-[-4px] opacity-0'
          }`}
        >
          <div className="mb-1 border-b border-[var(--line-subtle)] px-2 py-2 text-xs leading-5 text-[var(--ink-muted)]">
            已通过 Google 登录<br />
            {session.user.email}
          </div>
          <button
            type="button"
            onClick={() => {
              setAccountMenuOpen(false);
              onLogout();
            }}
            className="flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </div>
      </div>
    </aside>
  );
}
