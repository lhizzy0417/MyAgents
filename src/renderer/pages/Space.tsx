import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Download,
  FileText,
  Hash,
  Loader2,
  LogIn,
  MessageSquare,
  Package,
  Plus,
  RefreshCw,
  Search,
  Send,
  UploadCloud,
  X,
} from 'lucide-react';

import myagentsWebLogo from '@/assets/brand/myagents-web-logo.png';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import {
  spaceAuthPoll,
  spaceAuthStart,
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
import { useConfig } from '@/hooks/useConfig';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import type { Project } from '@/config/types';

type ViewMode = 'issues' | 'skills' | 'agents';

const STATUS_OPTIONS: SelectOption[] = [
  { value: '', label: '全部状态' },
  { value: 'open', label: 'Open' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAdmin(session: SpaceSession | null): boolean {
  return session?.membership?.role === 'owner' || session?.membership?.role === 'admin';
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function issueStatusLabel(status: string): string {
  return status.replaceAll('_', ' ');
}

export default function Space({ isActive }: { isActive: boolean }) {
  const toast = useToast();
  const { projects } = useConfig();
  const [session, setSession] = useState<SpaceSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [authBusy, setAuthBusy] = useState(false);
  const [authToken, setAuthToken] = useState<string | null>(null);
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

  const loadSession = useCallback(async () => {
    setLoading(true);
    try {
      const next = await spaceGetSession();
      setSession(next);
      if (next) {
        const official = await spaceGetOfficial();
        setTags(official.tags);
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
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    if (session) {
      void loadIssues();
      void loadSkills();
      void loadLocalAgents();
    }
  }, [loadIssues, loadLocalAgents, loadSkills, session]);

  useEffect(() => {
    if (!authToken) return;
    const timer = window.setInterval(async () => {
      try {
        const result = await spaceAuthPoll(authToken);
        if (result.status === 'done') {
          window.clearInterval(timer);
          setAuthToken(null);
          setAuthBusy(false);
          toast.success('已登录 MyAgents社区');
          await loadSession();
        } else if (result.status === 'failed') {
          window.clearInterval(timer);
          setAuthToken(null);
          setAuthBusy(false);
          toast.error(String(result.error ?? '登录失败'));
        }
      } catch (error) {
        window.clearInterval(timer);
        setAuthToken(null);
        setAuthBusy(false);
        toast.error(errMessage(error));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [authToken, loadSession, toast]);

  const processDispatches = useCallback(async () => {
    if (!session || localAgents.length === 0) return;
    const result = await spaceProcessDispatchesOnce();
    if (result.processed > 0) {
      toast.success(`已处理 ${result.processed} 个 Space 派发任务`);
    }
    for (const error of result.errors) {
      toast.error(error);
    }
  }, [localAgents.length, session, toast]);

  useEffect(() => {
    if (!isActive || !session || localAgents.length === 0) return;
    void processDispatches().catch((error) => toast.error(errMessage(error)));
  }, [isActive, localAgents.length, processDispatches, session, toast]);

  const startLogin = useCallback(async () => {
    setAuthBusy(true);
    try {
      const result = await spaceAuthStart();
      setAuthToken(result.loginToken);
      toast.info('已打开浏览器登录');
    } catch (error) {
      setAuthBusy(false);
      toast.error(errMessage(error));
    }
  }, [toast]);

  if (loading) {
    return <div className="flex h-full items-center justify-center bg-[var(--paper)] text-[var(--ink-muted)]"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载云空间</div>;
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center bg-[var(--paper)] px-6">
        <div className="w-full max-w-md rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-6 shadow-sm">
          <div className="mb-5 flex items-center gap-3">
            <img src={myagentsWebLogo} alt="" className="h-10 w-10 rounded-lg shadow-sm" />
            <div>
              <p className="text-xs font-medium text-[var(--accent-warm)]">MyAgents社区</p>
              <h1 className="text-xl font-semibold text-[var(--ink)]">选择登录方式</h1>
              <p className="text-sm text-[var(--ink-muted)]">使用 Google 账号登录后自动加入官方 Space</p>
            </div>
          </div>
          <button
            type="button"
            disabled={authBusy}
            onClick={startLogin}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {authBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            {authBusy ? '等待 Google 登录完成' : '继续使用 Google'}
          </button>
          <p className="mt-3 text-center text-xs text-[var(--ink-muted)]">
            浏览器完成授权后，此页面会自动同步登录状态。
          </p>
        </div>
      </div>
    );
  }

  const tagOptions: SelectOption[] = [{ value: '', label: '全部标签' }, ...tags.map((tag) => ({ value: tag.id, label: tag.name }))];

  return (
    <div className="flex h-full flex-col bg-[var(--paper)] text-[var(--ink)]">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-5">
        <div className="flex items-center gap-3">
          <img src={myagentsWebLogo} alt="" className="h-8 w-8 rounded-lg shadow-sm" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-[var(--ink)]">{session.space.name}</h1>
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                {session.membership.role}
              </span>
            </div>
            <p className="text-xs text-[var(--ink-muted)]">{session.user.email}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(['issues', 'skills', 'agents'] as ViewMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={`h-8 rounded-lg px-3 text-sm font-medium transition-colors ${
                mode === item
                  ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]'
                  : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
              }`}
            >
              {item === 'issues' ? 'Issues' : item === 'skills' ? 'Skills' : 'Agents'}
            </button>
          ))}
          <button
            type="button"
            onClick={() => void loadSession()}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void spaceLogout().then(loadSession)}
            className="flex h-8 items-center rounded-lg px-3 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            退出
          </button>
        </div>
      </header>

      {mode === 'issues' && (
        <main className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--line-subtle)] px-5">
            <div className="relative w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-subtle)]" />
              <input
                value={issueQ}
                onChange={(event) => setIssueQ(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void loadIssues(); }}
                className="h-9 w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] pl-9 pr-3 text-sm text-[var(--ink)] outline-none transition-colors placeholder:text-[var(--ink-subtle)] focus:border-[var(--accent-warm)]"
                placeholder="搜索标题"
              />
            </div>
            <CustomSelect value={selectedTag} options={tagOptions} onChange={setSelectedTag} className="w-40" size="md" />
            <CustomSelect value={selectedStatus} options={STATUS_OPTIONS} onChange={setSelectedStatus} className="w-44" size="md" />
            <button
              type="button"
              onClick={() => void loadIssues()}
              className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
            >
              <RefreshCw className="h-4 w-4" />
              刷新
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setCreateIssueOpen(true)}
              className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            >
              <Plus className="h-4 w-4" />
              新建 Issue
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {issuesLoading ? (
              <div className="flex h-40 items-center justify-center text-sm text-[var(--ink-muted)]"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载 Issues</div>
            ) : (
              <div className="space-y-2">
                {issues.map((issue) => (
                  <button
                    key={issue.id}
                    type="button"
                    onClick={() => setIssueDetailId(issue.id)}
                    className="w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4 text-left transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)]"
                  >
                    <div className="flex items-start gap-3">
                      <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent-cool)]" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h2 className="truncate text-base font-semibold text-[var(--ink)]">{issue.title}</h2>
                          <span className="shrink-0 rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                            {issueStatusLabel(issue.status)}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm text-[var(--ink-muted)]">{issue.body}</p>
                        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-subtle)]">
                          {issue.tags?.map((tag) => (
                            <span key={tag.id} className="inline-flex items-center gap-1 rounded-md bg-[var(--paper-inset)] px-2 py-0.5">
                              <Hash className="h-3 w-3" />
                              {tag.name}
                            </span>
                          ))}
                          <span>{issue.commentCount ?? 0} 评论</span>
                          <span>{formatTime(issue.updatedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                ))}
                {issues.length === 0 && (
                  <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[var(--line)] text-sm text-[var(--ink-muted)]">
                    暂无 Issue
                  </div>
                )}
              </div>
            )}
          </div>
        </main>
      )}

      {mode === 'skills' && (
        <SkillsPane
          admin={admin}
          skills={skills}
          loading={skillsLoading}
          selectedSkillId={selectedSkillId}
          onSelectSkill={setSelectedSkillId}
          projects={projects}
          onRefresh={loadSkills}
          onUploaded={(skillId) => setSelectedSkillId(skillId)}
        />
      )}

      {mode === 'agents' && (
        <AgentsPane
          admin={admin}
          projects={projects}
          agents={localAgents}
          onRegister={() => setRegisterOpen(true)}
          onRefresh={loadLocalAgents}
        />
      )}

      {issueDetailId && (
        <IssueDetailOverlay
          issueId={issueDetailId}
          admin={admin}
          localAgents={localAgents}
          onClose={() => setIssueDetailId(null)}
          onChanged={() => {
            void loadIssues();
            void loadSkills();
          }}
        />
      )}

      {createIssueOpen && (
        <CreateIssueDialog
          tags={tags}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={() => {
            setCreateIssueOpen(false);
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

function CreateIssueDialog({ tags, onClose, onCreated }: { tags: SpaceTag[]; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagId, setTagId] = useState(tags[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => { onClose(); return true; }, 220);

  const options = tags.map((tag) => ({ value: tag.id, label: tag.name }));

  const submit = async () => {
    if (!title.trim() || !body.trim()) {
      toast.warning('标题和内容不能为空');
      return;
    }
    setBusy(true);
    try {
      await spaceCreateIssue({ title: title.trim(), body: body.trim(), tags: tagId ? [tagId] : [] });
      toast.success('Issue 已创建');
      onCreated();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220]">
      <div className="w-full max-w-xl rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--ink)]">新建 Issue</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-warm)]" placeholder="标题" />
          <textarea value={body} onChange={(e) => setBody(e.target.value)} className="h-40 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm outline-none focus:border-[var(--accent-warm)]" placeholder="内容" />
          <CustomSelect value={tagId} options={options} onChange={setTagId} placeholder="标签" size="md" />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]">取消</button>
          <button type="button" disabled={busy} onClick={() => void submit()} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            创建
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function IssueDetailOverlay({
  issueId,
  admin,
  localAgents,
  onClose,
  onChanged,
}: {
  issueId: string;
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
  useCloseLayer(() => { onClose(); return true; }, 230);

  const load = useCallback(async () => {
    setDetail(await spaceGetIssue(issueId));
  }, [issueId]);

  useEffect(() => {
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

  const uploadAttachments = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        directory: false,
        title: '选择 Issue 附件',
      });
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

  return (
    <OverlayBackdrop onClose={onClose} className="z-[230] items-stretch justify-end bg-black/20">
      <aside className="flex h-full w-[min(75vw,980px)] flex-col border-l border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-5">
          <h2 className="min-w-0 truncate text-lg font-semibold text-[var(--ink)]">{detail?.issue.title ?? 'Issue'}</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
        </div>
        {!detail ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--ink-muted)]"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载 Issue</div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">{issueStatusLabel(detail.issue.status)}</span>
              {detail.issue.tags?.map((tag) => <span key={tag.id} className="rounded-md bg-[var(--accent-warm-subtle)] px-2 py-0.5 text-xs font-medium text-[var(--accent-warm)]">{tag.name}</span>)}
              <span className="text-xs text-[var(--ink-subtle)]">{formatTime(detail.issue.createdAt)}</span>
            </div>
            <div className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-4 text-sm leading-6 text-[var(--ink-secondary)] whitespace-pre-wrap">{detail.issue.body}</div>
            <section className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold text-[var(--ink)]">附件</h3>
                <button type="button" disabled={attachmentUploading} onClick={() => void uploadAttachments()} className="flex h-8 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-xs font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
                  {attachmentUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UploadCloud className="h-3.5 w-3.5" />}
                  上传附件
                </button>
              </div>
              {detail.attachments.length > 0 ? (
                <div className="space-y-2">
                  {detail.attachments.map((attachment) => (
                    <div key={attachment.id} className="flex items-center justify-between rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-sm">
                      <span className="min-w-0 truncate text-[var(--ink-secondary)]">{attachment.name}</span>
                      <span className="text-xs text-[var(--ink-muted)]">{Math.ceil(attachment.sizeBytes / 1024)} KB</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-[var(--line)] px-3 py-4 text-center text-sm text-[var(--ink-muted)]">暂无附件</div>
              )}
            </section>
            <section className="mt-5">
              <h3 className="mb-2 text-sm font-semibold text-[var(--ink)]">评论</h3>
              <div className="space-y-2">
                {detail.comments.items.map((item) => (
                  <div key={item.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3">
                    <div className="mb-1 flex items-center gap-2 text-xs text-[var(--ink-subtle)]">
                      <span>{item.author.type}</span>
                      <span>{formatTime(item.createdAt)}</span>
                    </div>
                    <div className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{item.body}</div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
        <div className="shrink-0 border-t border-[var(--line)] p-4">
          {admin && localAgents.length > 0 && (
            <div className="mb-3 flex items-center gap-2">
              <CustomSelect value={agentId} options={localAgents.map((agent) => ({ value: agent.id, label: agent.displayName }))} onChange={setAgentId} className="w-64" size="md" />
              <button type="button" disabled={busy || !agentId} onClick={() => void dispatch()} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                派发
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <textarea value={comment} onChange={(event) => setComment(event.target.value)} className="h-20 flex-1 resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm outline-none focus:border-[var(--accent-warm)]" placeholder="评论" />
            <button type="button" disabled={busy || !comment.trim()} onClick={() => void sendComment()} className="flex w-24 items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
              <Send className="h-4 w-4" />
              发送
            </button>
          </div>
        </div>
      </aside>
    </OverlayBackdrop>
  );
}

function SkillsPane({
  admin,
  skills,
  loading,
  selectedSkillId,
  onSelectSkill,
  projects,
  onRefresh,
  onUploaded,
}: {
  admin: boolean;
  skills: SpaceSkill[];
  loading: boolean;
  selectedSkillId: string | null;
  onSelectSkill: (id: string) => void;
  projects: Project[];
  onRefresh: () => Promise<void>;
  onUploaded: (id: string) => void;
}) {
  const toast = useToast();
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
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setUploading(false);
    }
  };

  return (
    <main className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
      <aside className="min-h-0 border-r border-[var(--line)]">
        <div className="flex h-12 items-center justify-between border-b border-[var(--line-subtle)] px-4">
          <h2 className="text-sm font-semibold text-[var(--ink)]">Skills</h2>
          <div className="flex items-center gap-1">
            {admin && (
              <button type="button" disabled={uploading} onClick={() => void uploadSkill()} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-70" title="上传 Skill">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              </button>
            )}
            <button type="button" onClick={() => void onRefresh()} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]" title="刷新"><RefreshCw className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto p-3">
          {loading ? <div className="p-4 text-sm text-[var(--ink-muted)]">加载中</div> : skills.map((skill) => (
            <button key={skill.id} type="button" onClick={() => onSelectSkill(skill.id)} className={`mb-2 w-full rounded-lg border p-3 text-left transition-colors ${selectedSkillId === skill.id ? 'border-[var(--accent-warm)] bg-[var(--accent-warm-subtle)]' : 'border-[var(--line)] bg-[var(--paper-elevated)] hover:bg-[var(--hover-bg)]'}`}>
              <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]"><Package className="h-4 w-4 text-[var(--accent-cool)]" />{skill.name}</div>
              {skill.description && <p className="mt-1 line-clamp-2 text-xs text-[var(--ink-muted)]">{skill.description}</p>}
            </button>
          ))}
        </div>
      </aside>
      <section className="min-h-0">
        {selected ? <SkillDetail skill={selected} projects={projects} /> : <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">选择 Skill</div>}
      </section>
    </main>
  );
}

function SkillDetail({ skill, projects }: { skill: SpaceSkill; projects: Project[] }) {
  const toast = useToast();
  const [detail, setDetail] = useState<SpaceSkillDetail | null>(null);
  const [selectedPath, setSelectedPath] = useState('SKILL.md');
  const [preview, setPreview] = useState('');
  const [installing, setInstalling] = useState<'global' | 'project' | null>(null);
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '');

  useEffect(() => {
    setDetail(null);
    setPreview('');
    setSelectedPath('SKILL.md');
    void spaceGetSkill(skill.id).then(setDetail).catch((error) => toast.error(errMessage(error)));
  }, [skill.id, toast]);

  useEffect(() => {
    if (!detail) return;
    const file = detail.files.find((item) => item.path === selectedPath && !item.isDir);
    if (!file) return;
    void spaceGetSkillFile(skill.id, selectedPath)
      .then((result) => setPreview(result.text ?? ''))
      .catch((error) => toast.error(errMessage(error)));
  }, [detail, selectedPath, skill.id, toast]);

  const install = async (target: 'global' | 'project') => {
    setInstalling(target);
    try {
      const result = await spaceInstallSkill({ skillId: skill.id, skillName: skill.name, target, workspacePath: target === 'project' ? projectPath : undefined });
      toast.success(result.renamed ? `已安装为 ${result.installedName}` : '安装成功');
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setInstalling(null);
    }
  };

  const projectOptions = projects.map((project) => ({ value: project.path, label: project.name || project.path }));
  const files = detail?.files ?? [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--line)] px-5">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-[var(--ink)]">{skill.name}</h2>
          <p className="truncate text-xs text-[var(--ink-muted)]">{skill.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" disabled={installing !== null} onClick={() => void install('global')} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
            {installing === 'global' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            全局安装
          </button>
          <CustomSelect value={projectPath} options={projectOptions} onChange={setProjectPath} className="w-56" size="md" placeholder="选择工作区" />
          <button type="button" disabled={installing !== null || !projectPath} onClick={() => void install('project')} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
            {installing === 'project' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            安装到项目
          </button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[280px_1fr]">
        <div className="min-h-0 overflow-y-auto border-r border-[var(--line)] p-3">
          {files.map((file) => (
            <button key={file.id} type="button" disabled={file.isDir} onClick={() => setSelectedPath(file.path)} className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${selectedPath === file.path ? 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]' : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)]'} ${file.isDir ? 'font-semibold' : ''}`}>
              <FileText className="h-4 w-4 shrink-0" />
              <span className="min-w-0 truncate">{file.path}</span>
            </button>
          ))}
        </div>
        <pre className="min-h-0 overflow-auto bg-[var(--paper)] p-5 text-sm leading-6 text-[var(--ink-secondary)] whitespace-pre-wrap">{preview || ' '}</pre>
      </div>
    </div>
  );
}

function AgentsPane({
  admin,
  projects,
  agents,
  onRegister,
  onRefresh,
}: {
  admin: boolean;
  projects: Project[];
  agents: LocalRegisteredAgent[];
  onRegister: () => void;
  onRefresh: () => Promise<void>;
}) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-[var(--ink)]">Registered Agents</h2>
          <p className="text-sm text-[var(--ink-muted)]">{agents.length} 个本地 Agent 工作区</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void onRefresh()} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]"><RefreshCw className="h-4 w-4" />刷新</button>
          {admin && <button type="button" onClick={onRegister} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)]"><Plus className="h-4 w-4" />登记 Agent</button>}
        </div>
      </div>
      <div className="grid gap-3">
        {agents.map((agent) => (
          <div key={agent.id} className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-base font-semibold text-[var(--ink)]"><Bot className="h-4 w-4 text-[var(--accent-cool)]" />{agent.displayName}</div>
                <p className="mt-1 truncate text-sm text-[var(--ink-muted)]">{agent.workspacePath}</p>
              </div>
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">{agent.status}</span>
            </div>
            <div className="mt-3 whitespace-pre-wrap rounded-lg bg-[var(--paper)] p-3 text-sm leading-6 text-[var(--ink-secondary)]">{agent.goalMd}</div>
          </div>
        ))}
        {agents.length === 0 && (
          <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-[var(--line)] text-sm text-[var(--ink-muted)]">
            {projects.length === 0 ? '暂无工作区' : '暂无本地 Registered Agent'}
          </div>
        )}
      </div>
    </main>
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
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [displayName, setDisplayName] = useState(projects[0]?.name ?? '');
  const [goalMd, setGoalMd] = useState('');
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => { onClose(); return true; }, 220);

  const projectOptions = projects.map((project) => ({ value: project.id, label: project.name || project.path }));
  const selectedProject = projects.find((project) => project.id === projectId) ?? null;

  const submit = async () => {
    if (!selectedProject || !displayName.trim() || !goalMd.trim()) {
      toast.warning('请填写 Agent 名称和 Goal');
      return;
    }
    setBusy(true);
    try {
      await spaceRegisterAgent({
        displayName: displayName.trim(),
        workspaceId: selectedProject.id,
        workspacePath: selectedProject.path,
        workspaceLabel: displayName.trim(),
        goalMd,
      });
      toast.success('Registered Agent 已登记');
      onRegistered();
    } catch (error) {
      toast.error(errMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220]">
      <div className="w-full max-w-2xl rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-[var(--ink)]">登记 Agent</h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-3">
          <CustomSelect value={projectId} options={projectOptions} onChange={(value) => {
            setProjectId(value);
            const project = projects.find((item) => item.id === value);
            if (project && !displayName.trim()) setDisplayName(project.name);
          }} size="md" placeholder="选择工作区" />
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none focus:border-[var(--accent-warm)]" placeholder="Agent 名称" />
          <textarea value={goalMd} onChange={(event) => setGoalMd(event.target.value)} className="h-52 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm leading-6 outline-none focus:border-[var(--accent-warm)]" placeholder="Goal / 预设 Prompt" />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-9 rounded-lg bg-[var(--button-secondary-bg)] px-3 text-sm font-medium text-[var(--button-secondary-text)] hover:bg-[var(--button-secondary-bg-hover)]">取消</button>
          <button type="button" disabled={busy} onClick={() => void submit()} className="flex h-9 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-3 text-sm font-medium text-[var(--button-primary-text)] hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            登记
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
