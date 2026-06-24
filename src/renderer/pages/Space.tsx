import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Bot,
  ChevronDown,
  Cloud,
  Download,
  FileText,
  Hash,
  Loader2,
  LogIn,
  LogOut,
  MessageSquare,
  Package,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  UploadCloud,
  User,
  X,
  Copy,
} from 'lucide-react';

import {
  spaceAuthAck,
  spaceAuthPoll,
  spaceAuthStart,
  spaceErrorMessage,
  type LocalRegisteredAgent,
  type SpaceIssue,
  type SpaceSession,
  type SpaceSkill,
  type SpaceTag,
} from '@/api/spaceCloud';
import myagentsWebLogo from '@/assets/brand/myagents-web-logo.png';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useConfig } from '@/hooks/useConfig';
import { copyPlainText } from '@/utils/markdownClipboard';
import {
  buildIssueCommandPrompt,
  buildIssueQueryKey,
  formatAgentSecondaryLabel,
  getIssueStatusOptions,
  isClosedIssue,
  isSpaceAdmin,
  issueStatusLabel,
  type IssueQueryParams,
} from '@/pages/space/spaceHelpers';
import {
  getIssueListState,
  getSkillFileState,
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceActions,
  type SpaceIssueDetailState,
  type SpaceSkillDetailState,
} from '@/pages/space/spaceStore';
import { useSpaceData } from '@/pages/space/useSpaceData';

type ViewMode = 'issues' | 'skills' | 'agents';
type SkillScreen = 'list' | 'detail';
type SkillDetailMode = 'overview' | 'files';

const AUTH_POLL_DELAY_MS = 2000;

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: '全部状态' },
  { value: 'open', label: 'Open' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

const PAPER_GRID_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--line-subtle) 1px, var(--paper-a0) 1px), linear-gradient(90deg, var(--line-subtle) 1px, var(--paper-a0) 1px)',
  backgroundSize: '24px 24px, 24px 24px',
  maskImage: 'linear-gradient(to bottom, rgb(0 0 0 / 0) 0, #000 120px, #000 calc(100% - 120px), rgb(0 0 0 / 0) 100%)',
};

const SPACE_BACKGROUND_STYLE: CSSProperties = {
  background: 'linear-gradient(180deg, var(--paper-elevated), var(--paper) 42%, var(--paper-inset)), var(--paper)',
};

function errMessage(error: unknown): string {
  return spaceErrorMessage(error);
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatDate(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return '0 KB';
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function initials(value?: string | null): string {
  const source = value?.trim() || 'MA';
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function roleLabel(role: string): string {
  if (role === 'owner') return 'owner';
  if (role === 'admin') return 'admin';
  return 'member';
}

function statusPillClass(status: string): string {
  if (status === 'in_progress') return 'bg-[var(--warning-bg)] text-[var(--warning)]';
  if (status === 'triaged') return 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]';
  if (status === 'resolved') return 'bg-[var(--success-bg)] text-[var(--success)]';
  if (isClosedIssue(status)) return 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
  return 'bg-[var(--success-bg)] text-[var(--success)]';
}

function isAgentAssignable(agent: LocalRegisteredAgent): boolean {
  return agent.status === 'active' || agent.status === 'online';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function Space({ isActive }: { isActive: boolean }) {
  const toast = useToast();
  const { projects } = useConfig();
  const spaceData = useSpaceData({ isActive });
  const { actions } = spaceData;
  const [authBusy, setAuthBusy] = useState(false);
  const [authFlow, setAuthFlow] = useState<{ token: string; expiresAt: number } | null>(null);
  const authPollWarningShownRef = useRef(false);
  const [mode, setMode] = useState<ViewMode>('issues');
  const [issueQ, setIssueQ] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [issueDetailId, setIssueDetailId] = useState<string | null>(null);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);

  const session = spaceData.session;
  const tags = spaceData.tags;
  const issueQuery = useMemo<IssueQueryParams>(() => ({
    q: issueQ,
    tag: selectedTag,
    status: selectedStatus,
    limit: 50,
  }), [issueQ, selectedStatus, selectedTag]);
  const issueQueryRef = useRef(issueQuery);
  const issueQueryKey = useMemo(() => buildIssueQueryKey(issueQuery), [issueQuery]);
  const issueList = getIssueListState(issueQuery);
  const issues = issueList.items;
  const issuesLoading = issueList.isLoading || (spaceData.boot === 'ready' && issueList.lastFetchedAt === 0);
  const skills = spaceData.skills.items;
  const skillsLoading = spaceData.skills.isLoading || (spaceData.boot === 'ready' && spaceData.skills.lastFetchedAt === 0);
  const effectiveSelectedSkillId = selectedSkillId ?? skills[0]?.id ?? null;
  const localAgents = spaceData.localAgents.items;
  const admin = isSpaceAdmin(session);

  const tagOptions = useMemo<SelectOption[]>(
    () => [{ value: '', label: '全部标签' }, ...tags.map((tag) => ({ value: tag.name, label: tag.name }))],
    [tags],
  );

  const issueMetrics = useMemo(() => {
    const open = issues.filter((issue) => !isClosedIssue(issue.status)).length;
    const inProgress = issues.filter((issue) => issue.status === 'in_progress').length;
    return { open, inProgress, total: issues.length };
  }, [issues]);

  useEffect(() => {
    issueQueryRef.current = issueQuery;
  }, [issueQuery]);

  useEffect(() => {
    if (spaceData.boot !== 'ready') return;
    if (mode === 'issues') {
      const handle = window.setTimeout(() => {
        actions.refreshIssues(issueQuery, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(errMessage(error)));
      }, 220);
      return () => window.clearTimeout(handle);
    }
    if (mode === 'skills') {
      void actions.refreshSkills({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(errMessage(error)));
    }
    if (mode === 'agents') {
      void actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(errMessage(error)));
    }
  }, [actions, issueQuery, issueQueryKey, mode, spaceData.boot, toast]);

  useEffect(() => {
    if (spaceData.boot !== 'ready' || !isActive) return;
    if (mode === 'issues') {
      void actions.refreshIssues(issueQuery, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
      if (issueDetailId) {
        void actions.refreshIssueDetail(issueDetailId, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
        void actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
      }
    }
    if (mode === 'skills') {
      void actions.refreshSkills({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
      if (effectiveSelectedSkillId) {
        void actions.refreshSkillDetail(effectiveSelectedSkillId, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
      }
    }
    if (mode === 'agents') {
      void actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
    }
  }, [actions, effectiveSelectedSkillId, isActive, issueDetailId, issueQuery, issueQueryKey, mode, spaceData.boot, toast]);

  useEffect(() => {
    if (!authFlow) return;
    let cancelled = false;

    const stopAuth = () => {
      authPollWarningShownRef.current = false;
      setAuthFlow(null);
      setAuthBusy(false);
    };

    const poll = async () => {
      while (!cancelled && Date.now() < authFlow.expiresAt) {
        const startedAt = Date.now();
        try {
          const result = await spaceAuthPoll(authFlow.token);
          if (cancelled) return;
          if (result.status === 'done') {
            stopAuth();
            toast.success('已登录 MyAgents 社区');
            await actions.ensureBootstrapped({ force: true });
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn('[Space] auth ack failed:', errMessage(error));
            });
            return;
          }
          if (result.status === 'failed') {
            stopAuth();
            toast.error(String(result.error ?? '登录失败'));
            void spaceAuthAck(authFlow.token).catch((error) => {
              console.warn('[Space] auth ack failed:', errMessage(error));
            });
            return;
          }
        } catch (_error) {
          if (cancelled) return;
          if (!authPollWarningShownRef.current && Date.now() < authFlow.expiresAt) {
            authPollWarningShownRef.current = true;
            toast.warning('登录状态同步较慢，正在继续重试');
          }
        }
        const elapsed = Date.now() - startedAt;
        await wait(Math.max(0, AUTH_POLL_DELAY_MS - elapsed));
      }

      if (!cancelled) {
        stopAuth();
        toast.error('登录等待超时，请重新发起 Google 登录');
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [actions, authFlow, toast]);

  const runDispatchProcessing = useCallback(async () => {
    if (!session || localAgents.length === 0) return;
    const result = await actions.processDispatchesOnce();
    if (result.processed > 0) toast.success(`已处理 ${result.processed} 个 Space 派发任务`);
    for (const error of result.errors) toast.error(error);
    if (result.processed > 0 || result.delivered > 0) {
      await Promise.all([
        actions.refreshIssues(issueQueryRef.current, { force: true, silent: true }),
        actions.refreshLocalAgents({ force: true, silent: true }),
      ]);
    }
  }, [actions, localAgents.length, session, toast]);

  const processDispatches = useCallback(async () => {
    await runDispatchProcessing();
  }, [runDispatchProcessing]);

  useEffect(() => {
    if (!isActive || !session || localAgents.length === 0) return;
    void runDispatchProcessing().catch((error) => toast.error(errMessage(error)));
  }, [isActive, localAgents.length, runDispatchProcessing, session, toast]);

  const startLogin = useCallback(async () => {
    setAuthBusy(true);
    try {
      const result = await spaceAuthStart();
      authPollWarningShownRef.current = false;
      setAuthFlow({
        token: result.loginToken,
        expiresAt: Date.now() + result.expiresInSeconds * 1000,
      });
      toast.info('已打开浏览器登录');
    } catch (error) {
      setAuthBusy(false);
      toast.error(errMessage(error));
    }
  }, [toast]);

  const selectSpaceTab = useCallback((next: ViewMode) => {
    setMode(next);
    setIssueDetailId(null);
  }, []);

  const refreshCurrent = useCallback(async () => {
    if (mode === 'issues') await actions.refreshIssues(issueQuery, { force: true });
    if (mode === 'skills') await actions.refreshSkills({ force: true });
    if (mode === 'agents') await actions.refreshLocalAgents({ force: true });
    toast.success('已刷新');
  }, [actions, issueQuery, mode, toast]);

  const logout = useCallback(async () => {
    try {
      await actions.logout();
      setIssueDetailId(null);
      toast.success('已退出 Space');
    } catch (error) {
      toast.error(errMessage(error));
    }
  }, [actions, toast]);

  if (spaceData.boot === 'idle' || spaceData.boot === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载团队
      </div>
    );
  }

  if (spaceData.boot === 'error') {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <div className="text-center">
          <p>{spaceData.bootError ?? '团队数据加载失败'}</p>
          <button
            type="button"
            onClick={() => void actions.ensureBootstrapped({ force: true }).catch((error) => toast.error(errMessage(error)))}
            className="mt-3 inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return <SpaceLogin authBusy={authBusy} authFlow={authFlow} onLogin={startLogin} />;
  }

  return (
    <div className="relative h-full overflow-hidden bg-[var(--paper)]" style={SPACE_BACKGROUND_STYLE}>
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30" style={PAPER_GRID_STYLE} />
      <div className="relative z-10 flex h-full min-h-0">
        <SpaceSidebar
          session={session}
          mode={mode}
          issueCount={issues.length}
          skillCount={skills.length}
          agentCount={localAgents.length}
          onSpaceTabChange={selectSpaceTab}
          onLogout={logout}
        />
        <section className="flex min-w-0 flex-1 flex-col">
          {mode === 'issues' && (
            <IssuesWorkspace
              admin={admin}
              issues={issues}
              issuesLoading={issuesLoading}
              issueMetrics={issueMetrics}
              issueQ={issueQ}
              selectedTag={selectedTag}
              selectedStatus={selectedStatus}
              tagOptions={tagOptions}
              tags={tags}
              activeIssueId={issueDetailId}
              onQueryChange={setIssueQ}
              onTagChange={setSelectedTag}
              onStatusChange={setSelectedStatus}
              onRefresh={refreshCurrent}
              onCreate={() => setCreateIssueOpen(true)}
              onOpenIssue={setIssueDetailId}
            />
          )}
          {mode === 'skills' && (
            <SkillsWorkspace
              admin={admin}
              skills={skills}
              loading={skillsLoading}
              selectedSkillId={effectiveSelectedSkillId}
              projects={projects}
              actions={actions}
              skillDetailState={effectiveSelectedSkillId ? spaceData.skillDetails[effectiveSelectedSkillId] : undefined}
              onSelectSkill={setSelectedSkillId}
              onRefresh={refreshCurrent}
              onUploaded={(id) => setSelectedSkillId(id)}
            />
          )}
          {mode === 'agents' && (
            <AgentsWorkspace
              agents={localAgents}
              projects={projects}
              onRefresh={refreshCurrent}
              onProcessDispatches={processDispatches}
              onRegister={() => setRegisterOpen(true)}
            />
          )}
        </section>
      </div>

      {issueDetailId && (
        <IssueDetailDrawer
          issueId={issueDetailId}
          session={session}
          admin={admin}
          projects={projects}
          localAgents={localAgents}
          detailState={spaceData.issueDetails[issueDetailId]}
          actions={actions}
          onClose={() => setIssueDetailId(null)}
          onChanged={() => void actions.refreshIssues(issueQuery, { force: true, silent: true })}
        />
      )}

      {createIssueOpen && (
        <CreateIssueDialog
          tags={tags}
          actions={actions}
          issueQuery={issueQuery}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={(keepOpen) => {
            if (!keepOpen) setCreateIssueOpen(false);
            void actions.refreshIssues(issueQuery, { force: true, silent: true });
          }}
        />
      )}

      {registerOpen && (
        <RegisterAgentDialog
          projects={projects}
          actions={actions}
          onClose={() => setRegisterOpen(false)}
          onRegistered={() => {
            setRegisterOpen(false);
            void actions.refreshLocalAgents({ force: true, silent: true });
          }}
        />
      )}
    </div>
  );
}

function SpaceLogin({
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

function SpaceSidebar({
  session,
  mode,
  issueCount,
  skillCount,
  agentCount,
  onSpaceTabChange,
  onLogout,
}: {
  session: SpaceSession;
  mode: ViewMode;
  issueCount: number;
  skillCount: number;
  agentCount: number;
  onSpaceTabChange: (mode: ViewMode) => void;
  onLogout: () => void;
}) {
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  useCloseLayer(() => {
    if (!accountMenuOpen) return false;
    setAccountMenuOpen(false);
    return true;
  }, 20);

  const communityItems: Array<{ mode: ViewMode; label: string; count?: number; icon: typeof MessageSquare }> = [
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

        <details className="group/space mb-2.5 border-b border-[var(--line-subtle)] pb-2.5" open>
          <summary className="grid min-h-11 cursor-pointer list-none grid-cols-[36px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--paper-elevated)]/70 [&::-webkit-details-marker]:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--accent-warm-subtle)] text-xs font-bold text-[var(--accent-warm)]">T</span>
            <span className="min-w-0">
              <span className="flex min-w-0 items-center gap-2">
                <strong className="truncate text-base font-semibold text-[var(--ink)]">我的小队</strong>
                <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">soon</span>
              </span>
              <span className="mt-0.5 block text-xs font-medium text-[var(--ink-muted)]">私有审核加入</span>
            </span>
            <ChevronDown className="h-4 w-4 -rotate-90 text-[var(--ink-muted)] transition-transform group-open/space:rotate-0" />
          </summary>
          <div className="ml-6 mt-1 rounded-lg border border-dashed border-[var(--line-subtle)] px-3 py-2 text-xs leading-5 text-[var(--ink-muted)]">
            私有团队空间尚未开放，当前只显示官方社区空间。
          </div>
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
        <div className={`absolute bottom-full left-0 right-0 z-20 mb-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 p-2 shadow-md backdrop-blur-md transition-all ${
          accountMenuOpen ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-[-4px] opacity-0'
        }`}>
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

function IssuesWorkspace({
  admin,
  issues,
  issuesLoading,
  issueMetrics,
  issueQ,
  selectedTag,
  selectedStatus,
  tagOptions,
  tags,
  activeIssueId,
  onQueryChange,
  onTagChange,
  onStatusChange,
  onRefresh,
  onCreate,
  onOpenIssue,
}: {
  admin: boolean;
  issues: SpaceIssue[];
  issuesLoading: boolean;
  issueMetrics: { open: number; inProgress: number; total: number };
  issueQ: string;
  selectedTag: string;
  selectedStatus: string;
  tagOptions: SelectOption[];
  tags: SpaceTag[];
  activeIssueId: string | null;
  onQueryChange: (value: string) => void;
  onTagChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
  onOpenIssue: (id: string) => void;
}) {
  return (
    <div className="grid min-h-0 flex-1 grid-rows-[58px_minmax(0,1fr)]">
      <section className="grid grid-cols-[minmax(260px,1fr)_160px_170px_auto_auto_auto] items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-2.5 backdrop-blur-md max-xl:grid-cols-[minmax(220px,1fr)_145px_145px_auto_auto_auto] max-lg:grid-cols-1 max-lg:auto-rows-min max-lg:py-3">
        <label className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
            <input
              value={issueQ}
              onChange={(event) => onQueryChange(event.target.value)}
              className="h-10 w-full rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/80 pl-9 pr-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
              placeholder="搜索标题"
            />
        </label>
        <CustomSelect value={selectedTag} options={tagOptions} onChange={onTagChange} className="min-w-0" />
        <CustomSelect value={selectedStatus} options={STATUS_FILTER_OPTIONS} onChange={onStatusChange} className="min-w-0" />
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
        >
          <RefreshCw className="h-4 w-4" />
          刷新
        </button>
        {admin ? <IssueOverviewMenu issueMetrics={issueMetrics} tags={tags} /> : <span />}
        <button
          type="button"
          onClick={onCreate}
          className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)]"
        >
          <Plus className="h-4 w-4" />
          新建 Issue
        </button>
      </section>

      <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-5">
        <section className="mx-auto max-w-[1280px]" aria-label="Issue list">
          <div className="mb-3 grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs font-semibold text-[var(--ink-muted)]">
            <strong className="text-base font-semibold text-[var(--ink-secondary)]">{issues.length} issues</strong>
            <span className="inline-flex items-center gap-2">
              {issuesLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              按发布时间排序 · 点击查看详情
            </span>
          </div>
          <div className="border-y border-[var(--line-subtle)]">
            {issues.length === 0 && issuesLoading ? (
              <div className="grid gap-0">
                {Array.from({ length: 4 }).map((_, index) => (
                  <div key={index} className="min-h-[78px] border-b border-[var(--line-subtle)] py-4 last:border-b-0">
                    <div className="h-4 w-44 rounded-md bg-[var(--paper-inset)]" />
                    <div className="mt-3 h-3 w-72 rounded-md bg-[var(--paper-inset)]" />
                  </div>
                ))}
              </div>
            ) : issues.length === 0 ? (
              <div className="grid min-h-44 place-items-center border-x border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-muted)]">
                暂无匹配 Issue
              </div>
            ) : (
              issues.map((issue, index) => (
                <IssueStreamRow
                  key={issue.id}
                  issue={issue}
                  active={activeIssueId === issue.id}
                  index={index}
                  onOpen={() => onOpenIssue(issue.id)}
                />
              ))
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function IssueOverviewMenu({
  issueMetrics,
  tags,
}: {
  issueMetrics: { open: number; inProgress: number; total: number };
  tags: SpaceTag[];
}) {
  const [open, setOpen] = useState(false);
  useCloseLayer(() => {
    if (!open) return false;
    setOpen(false);
    return true;
  }, 20);

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-10 items-center justify-center gap-2 rounded-xl bg-transparent px-3 text-sm font-semibold text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
      >
        <Settings className="h-4 w-4" />
        概览
      </button>
      <div
        className={`absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/95 p-2 shadow-md backdrop-blur-md transition-all ${
          open ? 'pointer-events-auto translate-y-0 opacity-100' : 'pointer-events-none translate-y-[-4px] opacity-0'
        }`}
      >
        <section className="m-0 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/50">
          <div className="flex h-11 items-center justify-between border-b border-[var(--line-subtle)] px-3.5">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
              <Activity className="h-4 w-4" />
              Space 概览
            </h2>
          </div>
          <div className="px-3.5 py-3">
            <MetricRow label="Open issues" value={issueMetrics.open} />
            <MetricRow label="Assigned to agents" value={issueMetrics.inProgress} />
            <MetricRow label="Waiting dispatch" value={Math.max(0, issueMetrics.open - issueMetrics.inProgress)} />
            <div className="mt-2 grid gap-2">
              <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 border-b border-[var(--line-subtle)] pb-2">
                <Send className="mt-0.5 h-4 w-4 text-[var(--accent-cool)]" />
                <span>
                  <strong className="block text-sm font-semibold text-[var(--ink-secondary)]">派发队列</strong>
                  <small className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">在 Agents 页登记后可派发</small>
                </span>
              </div>
              <div className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
                <Hash className="mt-0.5 h-4 w-4 text-[var(--accent-cool)]" />
                <span>
                  <strong className="block text-sm font-semibold text-[var(--ink-secondary)]">tag 配置</strong>
                  <small className="mt-0.5 block text-xs leading-5 text-[var(--ink-muted)]">
                    {tags.map((tag) => tag.name).join(' / ') || '暂无 tags'}
                  </small>
                </span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3 border-b border-[var(--line-subtle)] py-2.5 last:border-b-0">
      <span className="font-medium text-[var(--ink-muted)]">{label}</span>
      <strong className="font-mono text-2xl font-semibold leading-none text-[var(--ink)]">{value}</strong>
    </div>
  );
}

function IssueStreamRow({
  issue,
  active,
  index,
  onOpen,
}: {
  issue: SpaceIssue;
  active: boolean;
  index: number;
  onOpen: () => void;
}) {
  const primaryTag = issue.tags?.[0] ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{ animationDelay: `${index * 42}ms` }}
      className={`grid min-h-[78px] w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-[var(--line-subtle)] px-1 py-4 text-left transition-colors last:border-b-0 sm:px-3 ${
        active ? 'bg-[var(--paper-elevated)]/70 shadow-[inset_3px_0_0_var(--accent-warm)]' : 'hover:bg-[var(--paper-elevated)]/60'
      }`}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-base font-semibold leading-6 text-[var(--ink)]">{issue.title}</span>
          {primaryTag && <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># {primaryTag.name}</span>}
          <span className={`rounded-md px-2 py-1 text-xs font-semibold ${statusPillClass(issue.status)}`}>{issueStatusLabel(issue.status)}</span>
        </span>
        <span className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
          <span>{issue.author?.name ?? issue.author?.id ?? 'owner'}</span>
          <span className="before:mr-2 before:text-[var(--line-strong)] before:content-['·']">{formatTime(issue.createdAt)}</span>
          <span className="before:mr-2 before:text-[var(--line-strong)] before:content-['·']">{issue.commentCount ?? 0} 评论</span>
        </span>
      </span>
      <span className="hidden pt-1 text-xs font-semibold text-[var(--ink-subtle)] sm:block">{formatTime(issue.updatedAt)}</span>
    </button>
  );
}

function CreateIssueDialog({
  tags,
  actions,
  issueQuery,
  onClose,
  onCreated,
}: {
  tags: SpaceTag[];
  actions: SpaceActions;
  issueQuery: IssueQueryParams;
  onClose: () => void;
  onCreated: (keepOpen: boolean) => void;
}) {
  const toast = useToast();
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tag, setTag] = useState(tags[0]?.name ?? '');
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [continuous, setContinuous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  useEffect(() => {
    window.setTimeout(() => titleInputRef.current?.focus(), 0);
  }, []);

  const tagOptions = useMemo<SelectOption[]>(
    () => [{ value: '', label: '无标签' }, ...tags.map((item) => ({ value: item.name, label: item.name }))],
    [tags],
  );

  const pickFiles = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: '选择 Issue 附件' });
      const next = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (next.length > 0) {
        setFilePaths((current) => Array.from(new Set([...current, ...next])));
      }
    } catch (error) {
      toast.error(errMessage(error));
    }
  };

  const submit = async () => {
    if (submittingRef.current) return;
    if (!title.trim() || !body.trim()) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const issue = await actions.createIssue({ title: title.trim(), body: body.trim(), tags: tag ? [tag] : [] });
      if (filePaths.length > 0) {
        await actions.uploadIssueAttachments(issue.id, filePaths);
      }
      toast.success(filePaths.length > 0 ? `已创建 Issue 并上传 ${filePaths.length} 个附件` : '已创建 Issue');
      await actions.refreshIssues(issueQuery, { force: true, silent: true });
      if (continuous) {
        setTitle('');
        setBody('');
        setFilePaths([]);
        window.setTimeout(() => titleInputRef.current?.focus(), 0);
        onCreated(true);
      } else {
        onCreated(false);
      }
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/30 p-7 backdrop-blur-sm">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="grid min-h-[520px] w-[min(1080px,calc(100vw-120px))] max-w-full grid-rows-[auto_minmax(0,1fr)_auto] rounded-[var(--radius-2xl)] border border-[var(--line)] bg-[var(--paper-elevated)]/95 px-6 py-5 shadow-xl"
      >
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4">
          <div className="flex min-h-[34px] items-center gap-2.5 text-base font-medium text-[var(--ink-muted)]">
            <span className="grid h-6 w-6 place-items-center rounded-lg border border-[var(--accent-warm-muted)] bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
              <Cloud className="h-3.5 w-3.5" />
            </span>
            <span>MyAgents社区</span>
            <span>›</span>
            <strong className="font-semibold text-[var(--ink)]">New issue</strong>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label="关闭"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="grid content-start gap-4 px-2.5 pb-5 pt-12">
          <input
            ref={titleInputRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full border-0 bg-transparent text-3xl font-semibold leading-tight text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]/60"
            placeholder="Issue title"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-40 w-full resize-none border-0 bg-transparent p-0 text-xl leading-8 text-[var(--ink-secondary)] outline-none placeholder:text-[var(--ink-muted)]/60"
            placeholder="Add description..."
          />
          {filePaths.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {filePaths.map((path) => (
                <span key={path} className="inline-flex items-center gap-1 rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-secondary)]">
                  <Paperclip className="h-3.5 w-3.5" />
                  {basename(path)}
                  <button
                    type="button"
                    onClick={() => setFilePaths((current) => current.filter((item) => item !== path))}
                    className="ml-0.5 grid h-4 w-4 place-items-center rounded-full text-[var(--ink-muted)] hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
                    aria-label={`移除 ${basename(path)}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4 max-lg:grid-cols-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-flex min-h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/70 px-3 text-sm font-medium text-[var(--ink-muted)] shadow-sm">
              <Hash className="h-4 w-4" />
              <CustomSelect value={tag} options={tagOptions} onChange={setTag} compact className="w-32 [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-0 [&>button]:shadow-none" />
            </span>
            <button
              type="button"
              onClick={() => void pickFiles()}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)]/80 px-3 text-sm font-semibold text-[var(--ink-muted)] shadow-sm transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
              aria-label="添加附件"
            >
              <Paperclip className="h-4 w-4" />
              附件
            </button>
          </div>
          <div className="flex items-center gap-3.5 pb-0.5">
            <button
              type="button"
              aria-pressed={continuous}
              onClick={() => setContinuous((value) => !value)}
              className="inline-flex items-center gap-2 rounded-full px-1 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              <span className={`h-6 w-11 rounded-full p-0.5 transition-colors ${continuous ? 'bg-[var(--accent-warm)]' : 'bg-[var(--line-strong)]'}`}>
                <span className={`block h-5 w-5 rounded-full bg-[var(--paper-elevated)] shadow-sm transition-transform ${continuous ? 'translate-x-5' : ''}`} />
              </span>
              持续创建
            </button>
            <button
              type="submit"
              disabled={submitting || !title.trim() || !body.trim()}
              className="flex h-11 items-center gap-2 rounded-full bg-[var(--button-primary-bg)] px-6 text-sm font-semibold text-[var(--button-primary-text)] shadow-sm transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              创建 Issue
            </button>
          </div>
        </div>
      </form>
    </OverlayBackdrop>
  );
}

function IssueDetailDrawer({
  issueId,
  session,
  admin,
  projects,
  localAgents,
  detailState,
  actions,
  onClose,
  onChanged,
}: {
  issueId: string;
  session: SpaceSession;
  admin: boolean;
  projects: Project[];
  localAgents: LocalRegisteredAgent[];
  detailState?: SpaceIssueDetailState;
  actions: SpaceActions;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [dispatchingAgentId, setDispatchingAgentId] = useState<string | null>(null);
  const detail = detailState?.detail ?? null;
  const loading = detailState?.isLoading ?? true;
  const statusOptions = useMemo(
    () => getIssueStatusOptions({ session, issue: detail?.issue ?? null }),
    [detail?.issue, session],
  );

  useCloseLayer(() => {
    onClose();
    return true;
  }, 230);

  useEffect(() => {
    void actions.refreshIssueDetail(issueId, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(errMessage(error)));
    if (admin) {
      void actions.refreshLocalAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(errMessage(error)));
    }
  }, [actions, admin, issueId, toast]);

  const changeStatus = async (option: { value: string; kind: 'set-status' | 'close-own' }) => {
    if (!detail) return;
    setStatusBusy(true);
    try {
      if (option.kind === 'close-own') {
        await actions.closeOwnIssue(issueId);
      } else {
        await actions.setIssueStatus(issueId, option.value);
      }
      setStatusMenuOpen(false);
      toast.success('Issue 状态已更新');
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setStatusBusy(false);
    }
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await actions.commentIssue(issueId, comment.trim());
      setComment('');
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const uploadAttachments = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: '选择 Issue 附件' });
      const filePaths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (filePaths.length === 0) return;
      setAttachmentUploading(true);
      const attachments = await actions.uploadIssueAttachments(issueId, filePaths);
      toast.success(`已上传 ${attachments.length} 个附件`);
      await actions.refreshIssueDetail(issueId, { force: true, silent: true });
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setAttachmentUploading(false);
    }
  };

  const assignAgent = async (agent: LocalRegisteredAgent) => {
    if (!isAgentAssignable(agent)) return;
    setDispatchingAgentId(agent.id);
    try {
      await actions.dispatchIssue(issueId, agent.id);
      const result = await actions.processDispatchesOnce();
      await Promise.all([
        actions.refreshIssueDetail(issueId, { force: true, silent: true }),
        actions.refreshLocalAgents({ force: true, silent: true }),
      ]);
      onChanged();
      if (result.errors.length > 0) {
        for (const error of result.errors) toast.error(error);
      } else if (result.processed > 0) {
        toast.success(`已指派给 ${agent.displayName}`);
      } else {
        toast.success(`已记录指派：${agent.displayName}`);
      }
      setAgentMenuOpen(false);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setDispatchingAgentId(null);
    }
  };

  const copyIssueCommand = async () => {
    try {
      await copyPlainText(buildIssueCommandPrompt({ spaceName: session.space.name, issueId }));
      toast.success('已复制 issue 口令');
    } catch (error) {
      toast.error(errMessage(error));
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm">
      <aside className="relative h-full w-[min(75vw,1120px)] border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <header className="absolute right-4 top-4 z-10 flex justify-end">
          <button type="button" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" aria-label="关闭详情">
            <X className="h-4 w-4" />
          </button>
        </header>

        {!detail && loading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载 Issue
          </div>
        ) : !detail ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            {detailState?.error ?? 'Issue 未找到'}
          </div>
        ) : (
          <section className="grid h-full min-h-0 grid-cols-[minmax(0,760px)_304px] content-start gap-[56px] overflow-y-auto px-[44px] py-[58px] pr-[34px] max-xl:grid-cols-1 max-xl:gap-8">
            <div className="min-w-0 max-w-[760px] pb-8 max-xl:max-w-none">
              <article className="pb-14">
                <div className="mb-4 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                  <span className="relative">
                    {statusOptions.length > 0 ? (
                      <button
                        type="button"
                        disabled={statusBusy}
                        onClick={() => setStatusMenuOpen((value) => !value)}
                        className={`inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors ${statusPillClass(detail.issue.status)} disabled:cursor-wait disabled:opacity-70`}
                      >
                        {statusBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        {issueStatusLabel(detail.issue.status)}
                        <ChevronDown className="h-3.5 w-3.5" />
                      </button>
                    ) : (
                      <span className={`inline-flex min-h-8 items-center rounded-md px-2.5 text-xs font-semibold ${statusPillClass(detail.issue.status)}`}>
                        {issueStatusLabel(detail.issue.status)}
                      </span>
                    )}
                    {statusMenuOpen && statusOptions.length > 0 && (
                      <div className="absolute left-0 top-full z-30 mt-2 w-48 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                        {statusOptions.map((option) => (
                          <button
                            key={`${option.kind}:${option.value}`}
                            type="button"
                            onClick={() => void changeStatus(option)}
                            className={`flex h-9 w-full items-center justify-between rounded-lg px-2.5 text-left text-sm font-semibold transition-colors hover:bg-[var(--paper-inset)] ${
                              detail.issue.status === option.value ? 'text-[var(--accent-warm)]' : 'text-[var(--ink-secondary)]'
                            }`}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  {detail.issue.tags?.map((tag) => (
                    <span key={tag.id} className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]">
                      # {tag.name}
                    </span>
                  ))}
                  <span>{formatTime(detail.issue.createdAt)}</span>
                </div>
                <h2 className="max-w-[30ch] text-3xl font-semibold leading-tight text-[var(--ink)]">{detail.issue.title}</h2>
                <div className="mt-5 max-w-[66ch] whitespace-pre-wrap text-base leading-7 text-[var(--ink-secondary)]">{detail.issue.body}</div>
              </article>

              <section className="pt-2">
                <h3 className="mb-5 flex items-center justify-between gap-3 text-lg font-semibold text-[var(--ink)]">
                  <span className="inline-flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    评论与处理记录
                  </span>
                  <small className="text-xs font-semibold text-[var(--ink-subtle)]">{detail.comments.items.length} 条</small>
                </h3>
                <div className="divide-y divide-[var(--line-subtle)]">
                  {detail.comments.items.length === 0 ? (
                    <div className="py-3 text-sm text-[var(--ink-muted)]">
                      暂无评论。可以直接在底部补充信息。
                    </div>
                  ) : (
                    detail.comments.items.map((item) => (
                      <article key={item.id} className="grid grid-cols-[34px_minmax(0,1fr)] gap-3 py-4 first:pt-0">
                        <div className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">
                          {initials(item.author.type)}
                        </div>
                        <div>
                          <div className="mb-1 flex items-baseline gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                            <strong className="text-[var(--ink-secondary)]">{item.author.type}</strong>
                            <span>{formatTime(item.createdAt)}</span>
                          </div>
                          <div className="max-w-[66ch] whitespace-pre-wrap text-sm leading-7 text-[var(--ink-secondary)]">{item.body}</div>
                        </div>
                      </article>
                    ))
                  )}
                </div>

                <div className="mt-6 overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)]/70 shadow-sm">
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    className="min-h-[92px] w-full resize-none border-0 bg-transparent p-3 text-sm leading-6 text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
                    placeholder="写一条评论，补充上下文或同步处理进展"
                  />
                  <div className="grid grid-cols-[auto_1fr_auto] items-center gap-2 border-t border-[var(--line-subtle)] p-2">
                    <button
                      type="button"
                      disabled={attachmentUploading}
                      onClick={() => void uploadAttachments()}
                      className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                      aria-label="上传附件"
                    >
                      {attachmentUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
                    </button>
                    <span />
                    <button
                      type="button"
                      disabled={busy || !comment.trim()}
                      onClick={() => void sendComment()}
                      className="grid h-9 w-9 place-items-center rounded-xl bg-[var(--button-primary-bg)] text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      aria-label="发送评论"
                      title="发送评论"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              </section>
            </div>

            <aside className="min-w-0 pt-2">
              <section className="pb-4">
                <div className="flex items-center justify-between pb-2.5">
                  <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--ink-muted)]">
                    <Paperclip className="h-4 w-4" />
                    附件
                  </h3>
                  <button
                    type="button"
                    disabled={attachmentUploading}
                    onClick={() => void uploadAttachments()}
                    className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                    title="上传附件"
                  >
                    {attachmentUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  </button>
                </div>
                {detail.attachments.length === 0 ? (
                  <div className="border-t border-dashed border-[var(--line)] py-4 text-sm text-[var(--ink-muted)]">暂无附件</div>
                ) : (
                  <div>
                    {detail.attachments.map((attachment) => (
                      <div key={attachment.id} className="grid min-h-[42px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 border-b border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-secondary)] first:border-t">
                        <Paperclip className="h-4 w-4" />
                        <span className="truncate">{attachment.name}</span>
                        <small className="text-xs text-[var(--ink-subtle)]">{formatBytes(attachment.sizeBytes)}</small>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="border-t border-dashed border-[var(--line)] py-4">
                <h3 className="mb-2.5 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[var(--ink-muted)]">
                  {admin ? <Send className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  {admin ? '派发给 Agent' : 'Issue 口令'}
                </h3>
                <div className="grid gap-2">
                  {admin && (
                    <div className="relative">
                      <button
                        type="button"
                        disabled={localAgents.length === 0 || dispatchingAgentId !== null}
                        onClick={() => setAgentMenuOpen((value) => !value)}
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      >
                        {dispatchingAgentId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                        指派 Agent
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      {agentMenuOpen && (
                        <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-72 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                          {localAgents.length === 0 ? (
                            <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">暂无 Registered Agent</div>
                          ) : (
                            localAgents.map((agent) => (
                              <button
                                key={agent.id}
                                type="button"
                                disabled={dispatchingAgentId !== null || !isAgentAssignable(agent)}
                                onClick={() => void assignAgent(agent)}
                                className="grid min-h-12 w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-55"
                              >
                                <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">
                                  {dispatchingAgentId === agent.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : initials(agent.displayName)}
                                </span>
                                <span className="min-w-0">
                                  <strong className="block truncate text-sm font-semibold text-[var(--ink)]">{agent.displayName}</strong>
                                  <small className="block truncate text-xs text-[var(--ink-muted)]">{formatAgentSecondaryLabel(agent, projects)}</small>
                                </span>
                                {!isAgentAssignable(agent) && (
                                  <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{agent.status}</span>
                                )}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => void copyIssueCommand()}
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                  >
                    <Copy className="h-4 w-4" />
                    复制 issue 口令
                  </button>
                </div>
              </section>
            </aside>
          </section>
        )}
      </aside>
    </OverlayBackdrop>
  );
}

function SkillsWorkspace({
  admin,
  skills,
  loading,
  selectedSkillId,
  projects,
  actions,
  skillDetailState,
  onSelectSkill,
  onRefresh,
  onUploaded,
}: {
  admin: boolean;
  skills: SpaceSkill[];
  loading: boolean;
  selectedSkillId: string | null;
  projects: Project[];
  actions: SpaceActions;
  skillDetailState?: SpaceSkillDetailState;
  onSelectSkill: (id: string) => void;
  onRefresh: () => Promise<void>;
  onUploaded: (id: string) => void;
}) {
  const toast = useToast();
  const [screen, setScreen] = useState<SkillScreen>('list');
  const [detailMode, setDetailMode] = useState<SkillDetailMode>('overview');
  const [uploading, setUploading] = useState(false);
  const selected = skills.find((skill) => skill.id === selectedSkillId) ?? null;

  const uploadSkill = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: '选择 Skill ZIP',
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setUploading(true);
      const result = await actions.uploadSkillZip({ filePath: selectedPath });
      toast.success(`已上传 ${result.name}`);
      await actions.refreshSkills({ force: true, silent: true });
      onUploaded(result.id);
      setScreen('detail');
      setDetailMode('overview');
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const openSkill = (id: string) => {
    onSelectSkill(id);
    setScreen('detail');
    setDetailMode('overview');
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[58px_minmax(0,1fr)]">
      <section className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2.5 font-semibold text-[var(--ink-secondary)]">
          <Package className="h-4 w-4 shrink-0" />
          <span>官方 Skill 空间</span>
          <small className="truncate text-xs font-medium text-[var(--ink-muted)]">默认列表，点击后进入安装详情</small>
        </div>
        <div className="flex items-center gap-2">
          {admin && (
          <button
            type="button"
            disabled={uploading}
            onClick={() => void uploadSkill()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            上传 Skill
          </button>
          )}
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>
      </section>

      {screen === 'list' || !selected ? (
        <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-5">
          <section className="mx-auto max-w-[1280px]" aria-label="Skill list">
            <div className="mb-3 grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs font-semibold text-[var(--ink-muted)]">
              <strong className="text-base font-semibold text-[var(--ink-secondary)]">{skills.length} skills</strong>
              <span className="inline-flex items-center gap-2">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                官方上传 · 点击查看详情
              </span>
            </div>
            <div className="border-y border-[var(--line-subtle)]">
              {loading ? (
                <div className="grid gap-0">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="min-h-[78px] border-b border-[var(--line-subtle)] py-4 last:border-b-0">
                      <div className="h-4 w-56 rounded-md bg-[var(--paper-inset)]" />
                      <div className="mt-3 h-3 w-80 rounded-md bg-[var(--paper-inset)]" />
                    </div>
                  ))}
                </div>
              ) : skills.length === 0 ? (
                <div className="grid min-h-44 place-items-center border-x border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-muted)]">
                  暂无 Skills
                </div>
              ) : (
                skills.map((skill, index) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => openSkill(skill.id)}
                    style={{ animationDelay: `${index * 42}ms` }}
                    className={`grid min-h-[78px] w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-[var(--line-subtle)] px-1 py-4 text-left transition-colors last:border-b-0 sm:px-3 ${
                      selectedSkillId === skill.id ? 'bg-[var(--paper-elevated)]/70 shadow-[inset_3px_0_0_var(--accent-warm)]' : 'hover:bg-[var(--paper-elevated)]/60'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold leading-6 text-[var(--ink)]">{skill.name}</span>
                        <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">rev {skill.latestRevision}</span>
                        <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># official</span>
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                        <span>official</span>
                        <span className="before:mr-2 before:text-[var(--line-strong)] before:content-['·']">{formatDate(skill.updatedAt)}</span>
                        <span className="before:mr-2 before:text-[var(--line-strong)] before:content-['·']">点击查看详情</span>
                      </span>
                    </span>
                    <span className="hidden pt-1 text-xs font-semibold text-[var(--ink-subtle)] sm:block">{formatDate(skill.updatedAt)}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </main>
      ) : (
        <SkillDetailWorkspace
          skill={selected}
          mode={detailMode}
          projects={projects}
          actions={actions}
          detailState={skillDetailState}
          onModeChange={setDetailMode}
          onBack={() => setScreen('list')}
        />
      )}
    </div>
  );
}

function SkillDetailWorkspace({
  skill,
  mode,
  projects,
  actions,
  detailState,
  onModeChange,
  onBack,
}: {
  skill: SpaceSkill;
  mode: SkillDetailMode;
  projects: Project[];
  actions: SpaceActions;
  detailState?: SpaceSkillDetailState;
  onModeChange: (mode: SkillDetailMode) => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [selectedPath, setSelectedPath] = useState('');
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '');
  const [installingTarget, setInstallingTarget] = useState<'global' | 'project' | null>(null);
  const detail = detailState?.detail ?? null;
  const detailLoading = detailState?.isLoading ?? true;
  const fileState = selectedPath ? getSkillFileState(skill.id, selectedPath) : null;
  const fileLoading = fileState?.isLoading ?? false;
  const fileText = fileState?.text ?? '';

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.path, label: project.displayName || project.name })),
    [projects],
  );
  const hasProjects = projectOptions.length > 0;

  useEffect(() => {
    setSelectedPath('');
    void actions.refreshSkillDetail(skill.id, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(errMessage(error)));
  }, [actions, skill.id, toast]);

  useEffect(() => {
    if (projectOptions.length === 0) {
      setProjectPath('');
      return;
    }
    if (!projectOptions.some((option) => option.value === projectPath)) {
      setProjectPath(projectOptions[0].value);
    }
  }, [projectOptions, projectPath]);

  useEffect(() => {
    if (!detail || selectedPath) return;
    const firstReadable = detail.files.find((file) => !file.isDir && file.name.toLowerCase() === 'skill.md') ?? detail.files.find((file) => !file.isDir);
    setSelectedPath(firstReadable?.path ?? '');
  }, [detail, selectedPath]);

  useEffect(() => {
    if (!selectedPath || mode !== 'files') return;
    void actions.refreshSkillFile(skill.id, selectedPath, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(errMessage(error)));
  }, [actions, mode, selectedPath, skill.id, toast]);

  const install = async (target: 'global' | 'project') => {
    const workspacePath = target === 'project' ? projectPath || projects[0]?.path : undefined;
    if (target === 'project' && !workspacePath) {
      toast.error('请选择目标工作区');
      return;
    }
    setInstallingTarget(target);
    try {
      const result = await actions.installSkill({
        skillId: skill.id,
        skillName: skill.name,
        target,
        workspacePath,
      });
      toast.success(`已安装到 ${result.target}`);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setInstallingTarget(null);
    }
  };

  return (
    <main className="min-h-0 overflow-hidden p-[18px_20px_24px]">
      <div className="grid h-full min-h-0 grid-rows-[42px_minmax(0,1fr)]">
        <nav className="flex items-center gap-2 text-sm font-semibold text-[var(--ink-muted)]" aria-label="Skill breadcrumb">
          <button type="button" onClick={onBack} className="rounded-md px-2 py-1 font-semibold transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]">
            Skills
          </button>
          <span>›</span>
          <strong className="truncate font-semibold text-[var(--ink)]">{skill.name}</strong>
        </nav>

        <section className="grid min-h-0 grid-rows-[86px_minmax(0,1fr)] overflow-hidden rounded-[20px] border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/50 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.52)]">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--line)] px-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold leading-tight text-[var(--ink)]">{skill.name}</h2>
            <p className="truncate text-sm text-[var(--ink-muted)]">{skill.description || 'No description'}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">rev {skill.latestRevision}</span>
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">official</span>
              <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># Skill</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex h-9 items-center gap-1 rounded-xl bg-[var(--paper-inset)]/50 p-1">
              <button
                type="button"
                onClick={() => onModeChange('overview')}
                className={`h-7 rounded-lg px-2.5 text-sm font-semibold transition-colors ${mode === 'overview' ? 'bg-[var(--paper-elevated)] text-[var(--accent-warm)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
              >
                概览
              </button>
              <button
                type="button"
                onClick={() => onModeChange('files')}
                className={`h-7 rounded-lg px-2.5 text-sm font-semibold transition-colors ${mode === 'files' ? 'bg-[var(--paper-elevated)] text-[var(--accent-warm)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
              >
                文件
              </button>
            </div>
            <button
              type="button"
              disabled={installingTarget !== null}
              onClick={() => void install('global')}
              className="flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              {installingTarget === 'global' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              全局安装
            </button>
            {hasProjects ? (
              <CustomSelect value={projectPath} options={projectOptions} onChange={setProjectPath} className="w-48" />
            ) : (
              <span className="inline-flex h-9 items-center rounded-xl bg-[var(--paper-inset)]/60 px-3 text-sm font-semibold text-[var(--ink-muted)]">
                无项目工作区
              </span>
            )}
            <button
              type="button"
              disabled={installingTarget !== null || !hasProjects}
              title={hasProjects ? '安装到选中的项目' : '暂无可安装的项目工作区'}
              onClick={() => void install('project')}
              className="flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {installingTarget === 'project' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              安装到项目
            </button>
          </div>
        </div>

        {!detail && detailLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载 Skill
          </div>
        ) : !detail ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            {detailState?.error ?? 'Skill 未找到'}
          </div>
        ) : mode === 'overview' ? (
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_320px] gap-4 overflow-auto p-5 max-lg:grid-cols-1">
            <section className="rounded-[20px] border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/60 p-4">
              <h3 className="mb-3 text-base font-semibold text-[var(--ink)]">Overview</h3>
              <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{detail.skill.description || 'No description'}</p>
            </section>
            <aside className="space-y-3">
              <div className="rounded-[20px] border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/60 p-4">
                <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">安装影响</h3>
                <div className="space-y-2 text-sm text-[var(--ink-secondary)]">
                  <div className="flex justify-between gap-3">
                    <span className="text-[var(--ink-muted)]">Files</span>
                    <span>{detail.files.filter((file) => !file.isDir).length}</span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-[var(--ink-muted)]">Updated</span>
                    <span>{formatDate(detail.skill.updatedAt)}</span>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="grid min-h-0 grid-cols-[270px_minmax(0,1fr)]">
            <aside className="min-h-0 overflow-auto border-r border-[var(--line)] bg-[var(--paper-inset)]/30 p-3">
              <div className="space-y-1">
                {detail.files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    disabled={file.isDir}
                    onClick={() => setSelectedPath(file.path)}
                    className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors ${
                      selectedPath === file.path
                        ? 'bg-[var(--hover-bg)] text-[var(--accent-warm)]'
                        : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]'
                    } ${file.isDir ? 'font-semibold opacity-80' : ''}`}
                  >
                    {file.isDir ? <Package className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 truncate">{file.path}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section className="min-w-0 bg-[var(--paper-inset)]/50">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载文件
                </div>
              ) : (
                <pre className="h-full overflow-auto whitespace-pre-wrap p-5 font-mono text-sm leading-7 text-[var(--ink-secondary)]">{fileState?.error ?? (fileText || 'Select a file')}</pre>
              )}
            </section>
          </div>
        )}
        </section>
      </div>
    </main>
  );
}

function AgentsWorkspace({
  agents,
  projects,
  onRefresh,
  onProcessDispatches,
  onRegister,
}: {
  agents: LocalRegisteredAgent[];
  projects: Project[];
  onRefresh: () => Promise<void>;
  onProcessDispatches: () => Promise<void>;
  onRegister: () => void;
}) {
  const [processing, setProcessing] = useState(false);

  const process = async () => {
    setProcessing(true);
    try {
      await onProcessDispatches();
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[58px_minmax(0,1fr)]">
      <section className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2.5 font-semibold text-[var(--ink-secondary)]">
          <Bot className="h-4 w-4 shrink-0" />
          <span>Registered Agents</span>
          <small className="truncate text-xs font-medium text-[var(--ink-muted)]">登记本地工作区，订阅并响应云端派发</small>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={processing || agents.length === 0}
            onClick={() => void process()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            同步派发
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
          <button
            type="button"
            onClick={onRegister}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Plus className="h-4 w-4" />
            登记 Agent
          </button>
        </div>
      </section>
      <main className="min-h-0 overflow-y-auto p-[18px_28px_24px]">
        {agents.length === 0 ? (
          <div className="grid h-40 place-items-center rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper-elevated)]/40 text-sm text-[var(--ink-muted)]">
            <Bot className="mb-3 h-8 w-8 text-[var(--ink-muted)]" />
            暂无 Registered Agents
          </div>
        ) : (
          <div>
            <div className="mb-2 grid h-10 grid-cols-[minmax(0,1fr)_auto] items-center text-xs font-semibold text-[var(--ink-muted)]">
              <span>{agents.length} registered agents</span>
              <span>owner/admin 可登记，member 只读</span>
            </div>
          <div className="grid max-w-[1180px] grid-cols-1 gap-3.5 lg:grid-cols-2">
            {agents.map((agent) => {
              return (
                <article key={agent.id} className="min-h-[238px] rounded-[20px] border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/50 p-4">
                  <div className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5">
                    <span className="grid h-[34px] w-[34px] place-items-center rounded-xl bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">
                      {initials(agent.displayName)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-sm font-semibold text-[var(--ink)]">{agent.displayName}</h3>
                      <p className="truncate text-xs text-[var(--ink-muted)]">{formatAgentSecondaryLabel(agent, projects)}</p>
                    </div>
                    <span className={`rounded-md px-2 py-1 text-xs font-semibold ${agent.status === 'active' || agent.status === 'online' ? 'bg-[var(--success-bg)] text-[var(--success)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'}`}>{agent.status}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--line-subtle)] pt-3">
                    <div className="flex flex-wrap gap-2">
                      <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># agent</span>
                    </div>
                    <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{formatTime(agent.updatedAt) || '未同步'}</span>
                  </div>
                  <details className="mt-3 border-t border-[var(--line-subtle)] pt-2.5">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--ink-muted)] hover:text-[var(--ink)] [&::-webkit-details-marker]:hidden">
                      <Settings className="h-4 w-4" />
                      查看登记设置
                    </summary>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <AgentStat label="Status" value={agent.status} />
                      <AgentStat label="Last sync" value={formatTime(agent.updatedAt) || 'n/a'} />
                      <AgentStat label="Workspace" value={agent.workspaceLabel || 'local'} />
                    </div>
                    <div className="mt-3 rounded-xl bg-[var(--paper-inset)]/40 p-3 text-sm leading-6 text-[var(--ink-secondary)] whitespace-pre-wrap">
                      Goal:
                      {'\n'}
                      {agent.goalMd}
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
          </div>
        )}
      </main>
    </div>
  );
}

function AgentStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-14 rounded-xl border border-[var(--line-subtle)] bg-[var(--paper-elevated)]/60 px-2.5 py-2">
      <span className="block text-xs font-semibold text-[var(--ink-muted)]">{label}</span>
      <strong className="mt-1 block truncate font-mono text-base leading-tight text-[var(--ink)]">{value}</strong>
    </div>
  );
}

function RegisterAgentDialog({
  projects,
  actions,
  onClose,
  onRegistered,
}: {
  projects: Project[];
  actions: SpaceActions;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(projects[0]?.id ?? '');
  const [goalMd, setGoalMd] = useState('');
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.id, label: project.displayName || project.name })),
    [projects],
  );

  const submit = async () => {
    const project = projects.find((item) => item.id === workspaceId);
    if (!project || !displayName.trim() || !goalMd.trim()) return;
    setBusy(true);
    try {
      await actions.registerAgent({
        displayName: displayName.trim(),
        workspaceId: project.id,
        workspacePath: project.path,
        workspaceLabel: project.displayName || project.name,
        goalMd: goalMd.trim(),
      });
      toast.success('Registered Agent 已创建');
      onRegistered();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">Register Agent</h2>
            <p className="text-sm text-[var(--ink-muted)]">Official Space</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              placeholder="Agent display name"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Workspace</span>
            <CustomSelect value={workspaceId} options={projectOptions} onChange={setWorkspaceId} size="md" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Goal</span>
            <textarea
              value={goalMd}
              onChange={(event) => setGoalMd(event.target.value)}
              className="h-44 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              placeholder="Describe what this registered agent should handle."
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg px-4 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !workspaceId || !displayName.trim() || !goalMd.trim()}
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            Register
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
