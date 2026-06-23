import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Bot,
  CheckCircle2,
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
  Users,
  X,
} from 'lucide-react';

import {
  findProjectForAgent,
  spaceAuthAck,
  spaceAuthPoll,
  spaceAuthStart,
  spaceCloseOwnIssue,
  spaceCommentIssue,
  spaceCreateIssue,
  spaceDispatchIssue,
  spaceGetIssue,
  spaceGetOfficial,
  spaceGetSession,
  spaceGetSkill,
  spaceGetSkillFile,
  spaceInstallSkill,
  spaceListIssues,
  spaceListLocalAgents,
  spaceListSkills,
  spaceLogout,
  spaceProcessDispatchesOnce,
  spaceRegisterAgent,
  spaceSetIssueStatus,
  spaceUploadIssueAttachments,
  spaceUploadSkillZip,
  type LocalRegisteredAgent,
  type SpaceIssue,
  type SpaceIssueDetail,
  type SpaceSession,
  type SpaceSkill,
  type SpaceSkillDetail,
  type SpaceTag,
} from '@/api/spaceCloud';
import myagentsWebLogo from '@/assets/brand/myagents-web-logo.png';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useConfig } from '@/hooks/useConfig';

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

const STATUS_ACTION_OPTIONS: SelectOption[] = STATUS_FILTER_OPTIONS.filter((option) => option.value !== '');
const CLOSED_ISSUE_STATUSES = new Set(['resolved', 'closed', 'declined', 'duplicate', 'archived']);

const PAPER_GRID_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(var(--line-subtle) 1px, var(--paper-a0) 1px), linear-gradient(90deg, var(--line-subtle) 1px, var(--paper-a0) 1px)',
  backgroundSize: '28px 28px',
  maskImage: 'linear-gradient(to bottom, rgb(0 0 0 / 0) 0, #000 120px, #000 calc(100% - 120px), rgb(0 0 0 / 0) 100%)',
};

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdmin(session: SpaceSession | null): boolean {
  return session?.membership?.role === 'owner' || session?.membership?.role === 'admin';
}

function isClosedIssue(status: string): boolean {
  return CLOSED_ISSUE_STATUSES.has(status);
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

function issueStatusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

function statusPillClass(status: string): string {
  if (status === 'in_progress') return 'bg-[var(--warning-bg)] text-[var(--warning)]';
  if (status === 'triaged') return 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]';
  if (status === 'resolved') return 'bg-[var(--success-bg)] text-[var(--success)]';
  if (isClosedIssue(status)) return 'bg-[var(--paper-inset)] text-[var(--ink-muted)]';
  return 'bg-[var(--success-bg)] text-[var(--success)]';
}

function roleLabel(role: SpaceSession['membership']['role']): string {
  if (role === 'owner') return 'Owner';
  if (role === 'admin') return 'Admin';
  return 'Member';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export default function Space({ isActive }: { isActive: boolean }) {
  const toast = useToast();
  const { projects } = useConfig();
  const [session, setSession] = useState<SpaceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authFlow, setAuthFlow] = useState<{ token: string; expiresAt: number } | null>(null);
  const authPollWarningShownRef = useRef(false);
  const [mode, setMode] = useState<ViewMode>('issues');
  const [tags, setTags] = useState<SpaceTag[]>([]);
  const [issues, setIssues] = useState<SpaceIssue[]>([]);
  const [issueQ, setIssueQ] = useState('');
  const [selectedTag, setSelectedTag] = useState('');
  const [selectedStatus, setSelectedStatus] = useState('');
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [issueDetailId, setIssueDetailId] = useState<string | null>(null);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [skills, setSkills] = useState<SpaceSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [localAgents, setLocalAgents] = useState<LocalRegisteredAgent[]>([]);
  const [registerOpen, setRegisterOpen] = useState(false);

  const admin = isAdmin(session);

  const tagOptions = useMemo<SelectOption[]>(
    () => [{ value: '', label: '全部标签' }, ...tags.map((tag) => ({ value: tag.name, label: tag.name }))],
    [tags],
  );

  const issueMetrics = useMemo(() => {
    const open = issues.filter((issue) => !isClosedIssue(issue.status)).length;
    const inProgress = issues.filter((issue) => issue.status === 'in_progress').length;
    return { open, inProgress, total: issues.length };
  }, [issues]);

  const loadSession = useCallback(async () => {
    setLoading(true);
    try {
      const next = await spaceGetSession();
      setSession(next);
      if (next) {
        const official = await spaceGetOfficial();
        setTags(official.tags);
      } else {
        setTags([]);
        setIssues([]);
        setSkills([]);
        setLocalAgents([]);
      }
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadIssues = useCallback(async () => {
    if (!session) return;
    setIssuesLoading(true);
    try {
      const result = await spaceListIssues({ q: issueQ, tag: selectedTag, status: selectedStatus, limit: 50 });
      setIssues(result.items);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setIssuesLoading(false);
    }
  }, [issueQ, selectedStatus, selectedTag, session, toast]);

  const loadSkills = useCallback(async () => {
    if (!session) return;
    setSkillsLoading(true);
    try {
      const result = await spaceListSkills();
      setSkills(result.items);
      setSelectedSkillId((current) => current ?? result.items[0]?.id ?? null);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setSkillsLoading(false);
    }
  }, [session, toast]);

  const loadLocalAgents = useCallback(async () => {
    try {
      setLocalAgents(await spaceListLocalAgents());
    } catch (error) {
      toast.error(errMessage(error));
    }
  }, [toast]);

  useEffect(() => {
    if (isActive) void loadSession();
  }, [isActive, loadSession]);

  useEffect(() => {
    if (!session) return;
    void loadSkills();
    void loadLocalAgents();
  }, [loadLocalAgents, loadSkills, session]);

  useEffect(() => {
    if (!session || mode !== 'issues') return;
    const handle = window.setTimeout(() => {
      void loadIssues();
    }, 220);
    return () => window.clearTimeout(handle);
  }, [loadIssues, mode, session]);

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
            await loadSession();
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
  }, [authFlow, loadSession, toast]);

  const runDispatchProcessing = useCallback(async () => {
    if (!session || localAgents.length === 0) return;
    const result = await spaceProcessDispatchesOnce();
    if (result.processed > 0) toast.success(`已处理 ${result.processed} 个 Space 派发任务`);
    for (const error of result.errors) toast.error(error);
  }, [localAgents.length, session, toast]);

  const processDispatches = useCallback(async () => {
    await runDispatchProcessing();
    await loadIssues();
  }, [loadIssues, runDispatchProcessing]);

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

  const changeMode = useCallback((next: ViewMode) => {
    setMode(next);
    setIssueDetailId(null);
  }, []);

  const refreshCurrent = useCallback(async () => {
    if (mode === 'issues') await loadIssues();
    if (mode === 'skills') await loadSkills();
    if (mode === 'agents') await loadLocalAgents();
    toast.success('已刷新');
  }, [loadIssues, loadLocalAgents, loadSkills, mode, toast]);

  const logout = useCallback(async () => {
    try {
      await spaceLogout();
      setSession(null);
      setTags([]);
      setIssues([]);
      setSkills([]);
      setLocalAgents([]);
      setIssueDetailId(null);
      toast.success('已退出 Space');
    } catch (error) {
      toast.error(errMessage(error));
    }
  }, [toast]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] text-sm text-[var(--ink-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载云空间
      </div>
    );
  }

  if (!session) {
    return <SpaceLogin authBusy={authBusy} authFlow={authFlow} onLogin={startLogin} />;
  }

  return (
    <div className="relative h-full overflow-hidden bg-[var(--paper)]">
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-40" style={PAPER_GRID_STYLE} />
      <div className="relative z-10 flex h-full min-h-0">
        <SpaceSidebar
          session={session}
          mode={mode}
          issueCount={issueMetrics.open}
          skillCount={skills.length}
          agentCount={localAgents.length}
          tagCount={tags.length}
          onModeChange={changeMode}
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
              localAgents={localAgents}
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
              selectedSkillId={selectedSkillId}
              projects={projects}
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
          localAgents={localAgents}
          onClose={() => setIssueDetailId(null)}
          onChanged={() => void loadIssues()}
        />
      )}

      {createIssueOpen && (
        <CreateIssueDialog
          tags={tags}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={(issueId) => {
            setCreateIssueOpen(false);
            setIssueDetailId(issueId);
            void loadIssues();
          }}
        />
      )}

      {registerOpen && (
        <RegisterAgentDialog
          projects={projects}
          onClose={() => setRegisterOpen(false)}
          onRegistered={() => {
            setRegisterOpen(false);
            void loadLocalAgents();
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
  tagCount,
  onModeChange,
  onLogout,
}: {
  session: SpaceSession;
  mode: ViewMode;
  issueCount: number;
  skillCount: number;
  agentCount: number;
  tagCount: number;
  onModeChange: (mode: ViewMode) => void;
  onLogout: () => void;
}) {
  const navItems: Array<{ mode: ViewMode; label: string; count: number; icon: typeof MessageSquare }> = [
    { mode: 'issues', label: 'Issues', count: issueCount, icon: MessageSquare },
    { mode: 'skills', label: 'Skills', count: skillCount, icon: Package },
    { mode: 'agents', label: 'Agents', count: agentCount, icon: Bot },
  ];

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--line)] bg-[var(--paper-elevated)]/95">
      <div className="border-b border-[var(--line)] p-4">
        <div className="flex items-start gap-3">
          <img src={myagentsWebLogo} alt="" className="h-11 w-11 rounded-xl shadow-sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-base font-semibold text-[var(--ink)]">{session.space.name}</h1>
              <span className="rounded-full bg-[var(--accent-warm-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--accent-warm)]">
                {roleLabel(session.membership.role)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
              <span className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--success)]" />
                Live
              </span>
              <span>Official Space</span>
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2">
          <MiniMetric label="Open" value={issueCount} />
          <MiniMetric label="Skills" value={skillCount} />
          <MiniMetric label="Tags" value={tagCount} />
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        <div>
          <div className="mb-2 flex items-center justify-between px-2 text-xs font-medium text-[var(--ink-muted)]">
            <span>Official</span>
            <Cloud className="h-3.5 w-3.5" />
          </div>
          <div className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const selected = mode === item.mode;
              return (
                <button
                  key={item.mode}
                  type="button"
                  onClick={() => onModeChange(item.mode)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                      : 'text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${selected ? 'bg-[var(--paper)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'}`}>
                    {item.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between px-2 text-xs font-medium text-[var(--ink-muted)]">
            <span>我的小队</span>
            <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">soon</span>
          </div>
          <button
            type="button"
            disabled
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--ink-muted)] opacity-70"
          >
            <Users className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Private Space</span>
          </button>
        </div>
      </nav>

      <div className="group relative border-t border-[var(--line)] p-3">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--paper-inset)]"
        >
          {session.user.avatarUrl ? (
            <img src={session.user.avatarUrl} alt="" className="h-9 w-9 rounded-full" />
          ) : (
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--paper-inset)] text-xs font-semibold text-[var(--ink-muted)]">
              {initials(session.user.name ?? session.user.email)}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-[var(--ink)]">{session.user.name ?? session.user.email}</span>
            <span className="block truncate text-xs text-[var(--ink-muted)]">{session.user.email}</span>
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
        </button>
        <div className="pointer-events-none absolute bottom-full left-3 right-3 mb-2 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-1 opacity-0 shadow-md transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            type="button"
            onClick={onLogout}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            <LogOut className="h-4 w-4" />
            退出 Space
          </button>
        </div>
      </div>
    </aside>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] px-2 py-2">
      <div className="text-base font-semibold text-[var(--ink)]">{value}</div>
      <div className="text-xs text-[var(--ink-muted)]">{label}</div>
    </div>
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
  localAgents,
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
  localAgents: LocalRegisteredAgent[];
  activeIssueId: string | null;
  onQueryChange: (value: string) => void;
  onTagChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
  onOpenIssue: (id: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[var(--line)] bg-[var(--paper-elevated)]/90 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-64 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-muted)]" />
            <input
              value={issueQ}
              onChange={(event) => onQueryChange(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] pl-9 pr-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
              placeholder="Search issues"
            />
          </div>
          <CustomSelect value={selectedTag} options={tagOptions} onChange={onTagChange} className="w-40" triggerIcon={<Hash className="h-3.5 w-3.5" />} />
          <CustomSelect value={selectedStatus} options={STATUS_FILTER_OPTIONS} onChange={onStatusChange} className="w-40" triggerIcon={<Activity className="h-3.5 w-3.5" />} />
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {admin && <IssueAdminMenu issueMetrics={issueMetrics} tags={tags} localAgents={localAgents} />}
          <button
            type="button"
            onClick={onCreate}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Plus className="h-4 w-4" />
            New Issue
          </button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto w-full max-w-6xl overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-sm">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--ink)]">Issue Stream</h2>
              <p className="text-sm text-[var(--ink-muted)]">
                {issueMetrics.open} open · {issueMetrics.inProgress} in progress · {issueMetrics.total} loaded
              </p>
            </div>
            {issuesLoading && (
              <span className="inline-flex items-center gap-2 rounded-full bg-[var(--paper-inset)] px-3 py-1 text-xs text-[var(--ink-muted)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Syncing
              </span>
            )}
          </div>

          {issues.length === 0 && !issuesLoading ? (
            <div className="flex min-h-80 flex-col items-center justify-center px-6 text-center">
              <MessageSquare className="mb-3 h-8 w-8 text-[var(--ink-muted)]" />
              <h3 className="text-base font-semibold text-[var(--ink)]">没有匹配的 Issue</h3>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">调整搜索或创建一个新的 Issue。</p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--line-subtle)]">
              {issues.map((issue) => (
                <IssueStreamRow
                  key={issue.id}
                  issue={issue}
                  active={activeIssueId === issue.id}
                  onOpen={() => onOpenIssue(issue.id)}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function IssueAdminMenu({
  issueMetrics,
  tags,
  localAgents,
}: {
  issueMetrics: { open: number; inProgress: number; total: number };
  tags: SpaceTag[];
  localAgents: LocalRegisteredAgent[];
}) {
  return (
    <div className="group relative">
      <button
        type="button"
        className="flex h-10 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
      >
        <Settings className="h-4 w-4" />
        Admin
      </button>
      <div className="pointer-events-none absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-3 opacity-0 shadow-md transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <div className="grid grid-cols-3 gap-2">
          <MiniMetric label="Open" value={issueMetrics.open} />
          <MiniMetric label="Agents" value={localAgents.length} />
          <MiniMetric label="Tags" value={tags.length} />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {tags.length === 0 ? (
            <span className="text-xs text-[var(--ink-muted)]">暂无 tags</span>
          ) : (
            tags.map((tag) => (
              <span key={tag.id} className="rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-secondary)]">
                {tag.name}
              </span>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function IssueStreamRow({ issue, active, onOpen }: { issue: SpaceIssue; active: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] gap-4 px-5 py-4 text-left transition-colors ${
        active ? 'bg-[var(--accent-warm-subtle)]' : 'hover:bg-[var(--paper-inset)]'
      }`}
    >
      <div className="min-w-0">
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClass(issue.status)}`}>
            {issueStatusLabel(issue.status)}
          </span>
          {issue.tags?.slice(0, 2).map((tag) => (
            <span key={tag.id} className="shrink-0 rounded-full bg-[var(--paper)] px-2 py-0.5 text-xs text-[var(--ink-muted)]">
              {tag.name}
            </span>
          ))}
          {issue.tags && issue.tags.length > 2 && (
            <span className="shrink-0 text-xs text-[var(--ink-muted)]">+{issue.tags.length - 2}</span>
          )}
        </div>
        <h3 className="truncate text-base font-semibold text-[var(--ink)]">{issue.title}</h3>
        <p className="mt-1 line-clamp-2 text-sm leading-6 text-[var(--ink-secondary)]">{issue.body}</p>
      </div>
      <div className="flex w-44 flex-col items-end justify-between text-xs text-[var(--ink-muted)]">
        <div className="text-right">
          <div>{formatTime(issue.updatedAt || issue.createdAt)}</div>
          <div className="mt-1 truncate">{issue.author?.name ?? issue.author?.id ?? 'member'}</div>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1">
            <MessageSquare className="h-3.5 w-3.5" />
            {issue.commentCount ?? 0}
          </span>
          <span className="inline-flex items-center gap-1">
            <Paperclip className="h-3.5 w-3.5" />
            {issue.attachmentCount ?? 0}
          </span>
        </div>
      </div>
    </button>
  );
}

function CreateIssueDialog({
  tags,
  onClose,
  onCreated,
}: {
  tags: SpaceTag[];
  onClose: () => void;
  onCreated: (issueId: string) => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tag, setTag] = useState(tags[0]?.name ?? '');
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const tagOptions = useMemo<SelectOption[]>(
    () => [{ value: '', label: '无标签' }, ...tags.map((item) => ({ value: item.name, label: item.name }))],
    [tags],
  );

  const pickFiles = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({ multiple: true, directory: false, title: '选择 Issue 附件' });
      const next = Array.isArray(selected) ? selected : selected ? [selected] : [];
      if (next.length > 0) setFilePaths(next);
    } catch (error) {
      toast.error(errMessage(error));
    }
  };

  const submit = async () => {
    if (!title.trim() || !body.trim()) return;
    setSubmitting(true);
    try {
      const result = await spaceCreateIssue({ title: title.trim(), body: body.trim(), tags: tag ? [tag] : [] });
      if (filePaths.length > 0) {
        await spaceUploadIssueAttachments({ issueId: result.issue.id, filePaths });
      }
      toast.success(filePaths.length > 0 ? `已创建 Issue 并上传 ${filePaths.length} 个附件` : '已创建 Issue');
      onCreated(result.issue.id);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-[min(960px,calc(100vw-48px))] flex-col rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">New Issue</h2>
            <p className="text-sm text-[var(--ink-muted)]">MyAgents 社区</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="w-full border-0 bg-transparent text-2xl font-semibold text-[var(--ink)] outline-none placeholder:text-[var(--ink-muted)]"
            placeholder="Issue title"
          />
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="mt-4 h-72 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4 text-base leading-7 text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
            placeholder="写下背景、期望结果和复现信息。"
          />
          {filePaths.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {filePaths.map((path) => (
                <span key={path} className="inline-flex items-center gap-1 rounded-full bg-[var(--paper-inset)] px-2 py-1 text-xs text-[var(--ink-secondary)]">
                  <Paperclip className="h-3.5 w-3.5" />
                  {basename(path)}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            <CustomSelect value={tag} options={tagOptions} onChange={setTag} className="w-40" triggerIcon={<Hash className="h-3.5 w-3.5" />} />
            <button
              type="button"
              onClick={() => void pickFiles()}
              className="flex h-10 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            >
              <Paperclip className="h-4 w-4" />
              Attach
            </button>
          </div>
          <button
            type="button"
            disabled={submitting || !title.trim() || !body.trim()}
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Create
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function IssueDetailDrawer({
  issueId,
  session,
  admin,
  localAgents,
  onClose,
  onChanged,
}: {
  issueId: string;
  session: SpaceSession;
  admin: boolean;
  localAgents: LocalRegisteredAgent[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<SpaceIssueDetail | null>(null);
  const [comment, setComment] = useState('');
  const [agentId, setAgentId] = useState(localAgents[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 230);

  useEffect(() => {
    setAgentId((current) => current || localAgents[0]?.id || '');
  }, [localAgents]);

  const load = useCallback(async () => {
    setDetail(await spaceGetIssue(issueId));
  }, [issueId]);

  useEffect(() => {
    setDetail(null);
    void load().catch((error) => toast.error(errMessage(error)));
  }, [load, toast]);

  const dispatch = async () => {
    if (!agentId) return;
    setBusy(true);
    try {
      await spaceDispatchIssue(issueId, agentId);
      toast.success('已派发给 Registered Agent');
      await load();
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const sendComment = async () => {
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await spaceCommentIssue(issueId, comment.trim());
      setComment('');
      await load();
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const changeStatus = async (status: string) => {
    if (!detail || detail.issue.status === status) return;
    setBusy(true);
    try {
      await spaceSetIssueStatus(issueId, status);
      toast.success(`Issue 已更新为 ${issueStatusLabel(status)}`);
      await load();
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const closeOwn = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      await spaceCloseOwnIssue(issueId);
      toast.success('Issue 已关闭');
      await load();
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
      const result = await spaceUploadIssueAttachments({ issueId, filePaths });
      toast.success(`已上传 ${result.attachments.length} 个附件`);
      await load();
      onChanged();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setAttachmentUploading(false);
    }
  };

  const canCloseOwn = !!detail && detail.issue.author?.id === session.user.id && !isClosedIssue(detail.issue.status);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[230] items-stretch justify-end bg-black/20 backdrop-blur-sm">
      <aside className="flex h-full w-[min(75vw,1120px)] flex-col border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
              <span>Official Space</span>
              <span>/</span>
              <span>Issue</span>
            </div>
            <h2 className="truncate text-lg font-semibold text-[var(--ink)]">{detail?.issue.title ?? 'Issue'}</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载 Issue
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
            <main className="min-h-0 overflow-y-auto px-6 py-5">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClass(detail.issue.status)}`}>
                  {issueStatusLabel(detail.issue.status)}
                </span>
                {detail.issue.tags?.map((tag) => (
                  <span key={tag.id} className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs text-[var(--ink-secondary)]">
                    {tag.name}
                  </span>
                ))}
                <span className="text-xs text-[var(--ink-subtle)]">{formatTime(detail.issue.createdAt)}</span>
              </div>
              <article className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-5">
                <h1 className="text-2xl font-semibold text-[var(--ink)]">{detail.issue.title}</h1>
                <div className="mt-4 whitespace-pre-wrap text-base leading-7 text-[var(--ink-secondary)]">{detail.issue.body}</div>
              </article>

              <section className="mt-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">Timeline</h3>
                <div className="space-y-3">
                  {detail.comments.items.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper)] px-4 py-8 text-center text-sm text-[var(--ink-muted)]">
                      暂无评论
                    </div>
                  ) : (
                    detail.comments.items.map((item) => (
                      <div key={item.id} className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
                        <div className="mb-2 flex items-center gap-2 text-xs text-[var(--ink-muted)]">
                          <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5">{item.author.type}</span>
                          <span>{formatTime(item.createdAt)}</span>
                        </div>
                        <div className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{item.body}</div>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </main>

            <aside className="min-h-0 overflow-y-auto border-l border-[var(--line)] bg-[var(--paper)] p-4">
              <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[var(--ink)]">Status</h3>
                  {canCloseOwn && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void closeOwn()}
                      className="text-xs font-medium text-[var(--accent-warm)] transition-colors hover:text-[var(--accent-warm-hover)] disabled:cursor-wait disabled:opacity-70"
                    >
                      Close
                    </button>
                  )}
                </div>
                {admin ? (
                  <CustomSelect value={detail.issue.status} options={STATUS_ACTION_OPTIONS} onChange={(value) => void changeStatus(value)} />
                ) : (
                  <span className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusPillClass(detail.issue.status)}`}>
                    {issueStatusLabel(detail.issue.status)}
                  </span>
                )}
              </section>

              <section className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-[var(--ink)]">Attachments</h3>
                  <button
                    type="button"
                    disabled={attachmentUploading}
                    onClick={() => void uploadAttachments()}
                    className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
                    title="上传附件"
                  >
                    {attachmentUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  </button>
                </div>
                {detail.attachments.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-6 text-center text-sm text-[var(--ink-muted)]">暂无附件</div>
                ) : (
                  <div className="space-y-2">
                    {detail.attachments.map((attachment) => (
                      <div key={attachment.id} className="rounded-lg border border-[var(--line-subtle)] bg-[var(--paper)] px-3 py-2">
                        <div className="truncate text-sm font-medium text-[var(--ink)]">{attachment.name}</div>
                        <div className="mt-1 text-xs text-[var(--ink-muted)]">{formatBytes(attachment.sizeBytes)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {admin && (
                <section className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                  <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">Dispatch</h3>
                  {localAgents.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-5 text-center text-sm text-[var(--ink-muted)]">
                      暂无 Registered Agent
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <CustomSelect value={agentId} options={localAgents.map((agent) => ({ value: agent.id, label: agent.displayName }))} onChange={setAgentId} />
                      <button
                        type="button"
                        disabled={busy || !agentId}
                        onClick={() => void dispatch()}
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                        Dispatch
                      </button>
                    </div>
                  )}
                </section>
              )}

              <section className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
                <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">CLI</h3>
                <pre className="overflow-x-auto rounded-lg bg-[var(--paper-inset)] p-3 font-mono text-xs leading-5 text-[var(--ink-secondary)]">
                  {`myagents space issue get ${detail.issue.id}\nmyagents space issue comment ${detail.issue.id}`}
                </pre>
              </section>
            </aside>
          </div>
        )}

        <div className="shrink-0 border-t border-[var(--line)] bg-[var(--paper-elevated)] p-4">
          <div className="flex gap-2">
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              className="h-20 flex-1 resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-muted)] focus:border-[var(--accent-warm)]"
              placeholder="Add a comment"
            />
            <button
              type="button"
              disabled={busy || !comment.trim()}
              onClick={() => void sendComment()}
              className="flex w-24 items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              <Send className="h-4 w-4" />
              Send
            </button>
          </div>
        </div>
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
  onSelectSkill,
  onRefresh,
  onUploaded,
}: {
  admin: boolean;
  skills: SpaceSkill[];
  loading: boolean;
  selectedSkillId: string | null;
  projects: Project[];
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
      const result = await spaceUploadSkillZip({ filePath: selectedPath });
      toast.success(`已上传 ${result.skill.name}`);
      await onRefresh();
      onUploaded(result.skill.id);
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)]/90 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--ink)]">Skills</h2>
          <p className="text-sm text-[var(--ink-muted)]">{skills.length} official skills</p>
        </div>
        <div className="flex items-center gap-2">
          {admin && (
            <button
              type="button"
              disabled={uploading}
              onClick={() => void uploadSkill()}
              className="flex h-10 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Upload
            </button>
          )}
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {screen === 'list' || !selected ? (
        <main className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-3 lg:grid-cols-2">
            {loading ? (
              <div className="col-span-full flex h-64 items-center justify-center text-sm text-[var(--ink-muted)]">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                加载 Skills
              </div>
            ) : skills.length === 0 ? (
              <div className="col-span-full flex h-64 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-elevated)] text-center">
                <Package className="mb-3 h-8 w-8 text-[var(--ink-muted)]" />
                <h3 className="text-base font-semibold text-[var(--ink)]">暂无 Skills</h3>
              </div>
            ) : (
              skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => openSkill(skill.id)}
                  className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left shadow-sm transition-colors hover:border-[var(--accent-warm)] hover:bg-[var(--paper)]"
                >
                  <div className="mb-3 flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
                      <Package className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-semibold text-[var(--ink)]">{skill.name}</h3>
                      <p className="text-xs text-[var(--ink-muted)]">rev {skill.latestRevision} · {formatDate(skill.updatedAt)}</p>
                    </div>
                  </div>
                  <p className="line-clamp-2 text-sm leading-6 text-[var(--ink-secondary)]">{skill.description || 'No description'}</p>
                </button>
              ))
            )}
          </div>
        </main>
      ) : (
        <SkillDetailWorkspace
          skill={selected}
          mode={detailMode}
          projects={projects}
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
  onModeChange,
  onBack,
}: {
  skill: SpaceSkill;
  mode: SkillDetailMode;
  projects: Project[];
  onModeChange: (mode: SkillDetailMode) => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const [detail, setDetail] = useState<SpaceSkillDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [fileText, setFileText] = useState('');
  const [fileLoading, setFileLoading] = useState(false);
  const [target, setTarget] = useState<'global' | 'project'>('global');
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '');
  const [installing, setInstalling] = useState(false);

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.path, label: project.displayName || project.name })),
    [projects],
  );

  useEffect(() => {
    setDetail(null);
    setSelectedPath('');
    setFileText('');
    void spaceGetSkill(skill.id)
      .then((next) => {
        setDetail(next);
        const firstReadable = next.files.find((file) => !file.isDir && file.name.toLowerCase() === 'skill.md') ?? next.files.find((file) => !file.isDir);
        setSelectedPath(firstReadable?.path ?? '');
      })
      .catch((error) => toast.error(errMessage(error)));
  }, [skill.id, toast]);

  useEffect(() => {
    if (!selectedPath || mode !== 'files') return;
    setFileLoading(true);
    void spaceGetSkillFile(skill.id, selectedPath)
      .then((result) => {
        if (result.binary) {
          setFileText(`Binary file · ${result.mimeType ?? 'unknown'} · ${formatBytes(result.sizeBytes)}`);
        } else {
          setFileText(result.text ?? '');
        }
      })
      .catch((error) => toast.error(errMessage(error)))
      .finally(() => setFileLoading(false));
  }, [mode, selectedPath, skill.id, toast]);

  const install = async () => {
    const workspacePath = target === 'project' ? projectPath || projects[0]?.path : undefined;
    if (target === 'project' && !workspacePath) {
      toast.error('请选择目标工作区');
      return;
    }
    setInstalling(true);
    try {
      const result = await spaceInstallSkill({
        skillId: skill.id,
        skillName: skill.name,
        target,
        workspacePath,
      });
      toast.success(`已安装到 ${result.target}`);
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mx-auto flex w-full max-w-6xl flex-col rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Skills
            </button>
            <h2 className="truncate text-lg font-semibold text-[var(--ink)]">{skill.name}</h2>
            <p className="text-sm text-[var(--ink-muted)]">rev {skill.latestRevision} · {formatDate(skill.updatedAt)}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-[var(--paper-inset)] p-1">
              <button
                type="button"
                onClick={() => onModeChange('overview')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${mode === 'overview' ? 'bg-[var(--paper)] text-[var(--ink)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
              >
                概览
              </button>
              <button
                type="button"
                onClick={() => onModeChange('files')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${mode === 'files' ? 'bg-[var(--paper)] text-[var(--ink)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
              >
                文件
              </button>
            </div>
            <CustomSelect
              value={target}
              options={[
                { value: 'global', label: 'Global' },
                { value: 'project', label: 'Project' },
              ]}
              onChange={(value) => setTarget(value as 'global' | 'project')}
              className="w-32"
            />
            {target === 'project' && <CustomSelect value={projectPath} options={projectOptions} onChange={setProjectPath} className="w-52" />}
            <button
              type="button"
              disabled={installing}
              onClick={() => void install()}
              className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              {installing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Install
            </button>
          </div>
        </div>

        {!detail ? (
          <div className="flex h-96 items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载 Skill
          </div>
        ) : mode === 'overview' ? (
          <div className="grid gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-5">
              <h3 className="mb-3 text-base font-semibold text-[var(--ink)]">Overview</h3>
              <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{detail.skill.description || 'No description'}</p>
            </section>
            <aside className="space-y-3">
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
                <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">Package</h3>
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
              <div className="rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
                <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">Highlights</h3>
                <div className="space-y-2 text-sm text-[var(--ink-secondary)]">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                    官方 Space 发布
                  </div>
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-[var(--ink-muted)]" />
                    可查看文件内容
                  </div>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="grid min-h-[520px] grid-cols-[280px_minmax(0,1fr)]">
            <aside className="border-r border-[var(--line)] bg-[var(--paper)] p-3">
              <div className="space-y-1">
                {detail.files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    disabled={file.isDir}
                    onClick={() => setSelectedPath(file.path)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors ${
                      selectedPath === file.path
                        ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                        : 'text-[var(--ink-secondary)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                    } ${file.isDir ? 'font-semibold opacity-80' : ''}`}
                  >
                    {file.isDir ? <Package className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 truncate">{file.path}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section className="min-w-0 bg-[var(--paper)]">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载文件
                </div>
              ) : (
                <pre className="h-full overflow-auto p-5 font-mono text-xs leading-6 text-[var(--ink-secondary)]">{fileText || 'Select a file'}</pre>
              )}
            </section>
          </div>
        )}
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)]/90 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--ink)]">Agents</h2>
          <p className="text-sm text-[var(--ink-muted)]">{agents.length} registered locally</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={processing || agents.length === 0}
            onClick={() => void process()}
            className="flex h-10 items-center gap-2 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm font-medium text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70"
          >
            {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Sync Dispatch
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--line)] bg-[var(--paper)] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onRegister}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
          >
            <Plus className="h-4 w-4" />
            Register
          </button>
        </div>
      </div>
      <main className="min-h-0 flex-1 overflow-y-auto p-5">
        {agents.length === 0 ? (
          <div className="mx-auto flex h-80 max-w-3xl flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper-elevated)] text-center">
            <Bot className="mb-3 h-8 w-8 text-[var(--ink-muted)]" />
            <h3 className="text-base font-semibold text-[var(--ink)]">暂无 Registered Agents</h3>
          </div>
        ) : (
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => {
              const project = findProjectForAgent(projects, agent);
              return (
                <article key={agent.id} className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 shadow-sm">
                  <div className="mb-4 flex items-start gap-3">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]">
                      <Bot className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-semibold text-[var(--ink)]">{agent.displayName}</h3>
                      <p className="truncate text-xs text-[var(--ink-muted)]">{project?.displayName || project?.name || agent.workspaceLabel || basename(agent.workspacePath)}</p>
                    </div>
                    <span className="rounded-full bg-[var(--success-bg)] px-2 py-0.5 text-xs font-medium text-[var(--success)]">{agent.status}</span>
                  </div>
                  <p className="line-clamp-3 text-sm leading-6 text-[var(--ink-secondary)]">{agent.goalMd}</p>
                  <details className="mt-4 rounded-lg bg-[var(--paper)] px-3 py-2 text-xs text-[var(--ink-muted)]">
                    <summary className="cursor-pointer text-[var(--ink-secondary)]">Diagnostics</summary>
                    <div className="mt-2 space-y-1">
                      <div className="truncate">id: {agent.id}</div>
                      <div className="truncate">workspace: {agent.workspacePath}</div>
                      <div>updated: {formatTime(agent.updatedAt)}</div>
                    </div>
                  </details>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}

function RegisterAgentDialog({
  projects,
  onClose,
  onRegistered,
}: {
  projects: Project[];
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
      await spaceRegisterAgent({
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
