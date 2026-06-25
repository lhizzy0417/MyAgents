import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, Copy, Download, FileText, Loader2, MessageSquare, Paperclip, Send, UploadCloud, X } from 'lucide-react';

import { spaceErrorMessage, type SpaceAttachment, type SpaceRegisteredAgent, type SpaceSession } from '@/api/spaceCloud';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { copyPlainText } from '@/utils/markdownClipboard';
import {
  buildIssueCommandPrompt,
  getIssueStatusOptions,
  issueDisplayTitle,
  issueStatusLabel,
} from '@/pages/space/spaceHelpers';
import {
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceActions,
  type SpaceIssueDetailState,
} from '@/pages/space/spaceStore';
import { formatBytes, formatTime, statusPillClass } from '@/pages/space/spaceUi';

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function initials(value?: string | null): string {
  const source = value?.trim() || 'MA';
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function isRegisteredAgentAssignable(agent: SpaceRegisteredAgent): boolean {
  return agent.status === 'active' || agent.status === 'online';
}

function formatRegisteredAgentSecondaryLabel(agent: SpaceRegisteredAgent): string {
  return agent.workspaceLabel || agent.status;
}

function buildAttachmentDownloadCommand(attachmentId: string): string {
  return `myagents space attachment download ${attachmentId}`;
}

export function IssueDetailDrawer({
  issueId,
  session,
  admin,
  projects,
  registeredAgents,
  detailState,
  actions,
  onClose,
  onChanged,
}: {
  issueId: string;
  session: SpaceSession;
  admin: boolean;
  projects: Project[];
  registeredAgents: SpaceRegisteredAgent[];
  detailState?: SpaceIssueDetailState;
  actions: SpaceActions;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [attachmentUploading, setAttachmentUploading] = useState(false);
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<string | null>(null);
  const [downloadedAttachmentPaths, setDownloadedAttachmentPaths] = useState<Record<string, string>>({});
  const [downloadTargetAttachmentId, setDownloadTargetAttachmentId] = useState<string | null>(null);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [dispatchingAgentId, setDispatchingAgentId] = useState<string | null>(null);
  const statusMenuRef = useRef<HTMLSpanElement | null>(null);
  const agentMenuRef = useRef<HTMLDivElement | null>(null);
  const downloadMenuRef = useRef<HTMLSpanElement | null>(null);
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
    void actions.refreshIssueDetail(issueId, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
    if (admin) {
      void actions.refreshRegisteredAgents({ maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS, silent: true }).catch((error) => toast.error(spaceErrorMessage(error)));
    }
  }, [actions, admin, issueId, toast]);

  useEffect(() => {
    setDownloadedAttachmentPaths({});
    setDownloadTargetAttachmentId(null);
  }, [issueId]);

  useEffect(() => {
    if (!statusMenuOpen && !agentMenuOpen && !downloadTargetAttachmentId) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (statusMenuOpen && statusMenuRef.current && !statusMenuRef.current.contains(target)) {
        setStatusMenuOpen(false);
      }
      if (agentMenuOpen && agentMenuRef.current && !agentMenuRef.current.contains(target)) {
        setAgentMenuOpen(false);
      }
      if (downloadTargetAttachmentId && downloadMenuRef.current && !downloadMenuRef.current.contains(target)) {
        setDownloadTargetAttachmentId(null);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [agentMenuOpen, downloadTargetAttachmentId, statusMenuOpen]);

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
      toast.error(spaceErrorMessage(error));
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
      toast.error(spaceErrorMessage(error));
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
      toast.error(spaceErrorMessage(error));
    } finally {
      setAttachmentUploading(false);
    }
  };

  const downloadAttachment = async (attachment: SpaceAttachment, workspacePath: string) => {
    if (!workspacePath) {
      toast.error('请选择 Agent 工作区');
      return;
    }
    setDownloadTargetAttachmentId(null);
    setDownloadingAttachmentId(attachment.id);
    try {
      const result = await actions.downloadIssueAttachment({
        issueId,
        attachmentId: attachment.id,
        workspacePath,
        fileName: attachment.name,
      });
      setDownloadedAttachmentPaths((paths) => ({ ...paths, [attachment.id]: result.fullPath }));
      toast.success(`已下载到 ${result.relativePath}`);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setDownloadingAttachmentId(null);
    }
  };

  const requestAttachmentDownload = (attachment: SpaceAttachment) => {
    if (projects.length === 0) {
      toast.error('暂无可用 Agent 工作区');
      return;
    }
    if (projects.length === 1) {
      void downloadAttachment(attachment, projects[0].path);
      return;
    }
    setDownloadTargetAttachmentId((current) => (current === attachment.id ? null : attachment.id));
  };

  const copyAttachmentCommand = async (attachment: SpaceAttachment) => {
    try {
      await copyPlainText(buildAttachmentDownloadCommand(attachment.id));
      toast.success('已复制附件下载命令');
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const copyDownloadedAttachmentPath = async (attachment: SpaceAttachment) => {
    const fullPath = downloadedAttachmentPaths[attachment.id];
    if (!fullPath) return;
    try {
      await copyPlainText(fullPath);
      toast.success('已复制附件本地路径');
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    }
  };

  const assignAgent = async (agent: SpaceRegisteredAgent) => {
    if (!isRegisteredAgentAssignable(agent)) return;
    setDispatchingAgentId(agent.id);
    try {
      await actions.dispatchIssue(issueId, agent.id);
      const result = await actions.processDispatchesOnce();
      await Promise.all([
        actions.refreshIssueDetail(issueId, { force: true, silent: true }),
        actions.refreshRegisteredAgents({ force: true, silent: true }),
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
      toast.error(spaceErrorMessage(error));
    } finally {
      setDispatchingAgentId(null);
    }
  };

  const copyIssueCommand = async () => {
    try {
      await copyPlainText(buildIssueCommandPrompt({ spaceName: session.space.name, issueId }));
      toast.success('已复制 issue 口令');
    } catch (error) {
      toast.error(spaceErrorMessage(error));
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
                  <span ref={statusMenuRef} className="relative">
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
                <h2 className="max-w-[68ch] text-2xl font-semibold leading-snug text-[var(--ink)]">{issueDisplayTitle(detail.issue)}</h2>
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
                      <div key={attachment.id} className="grid min-h-[48px] grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 border-b border-dashed border-[var(--line-subtle)] py-1.5 text-sm text-[var(--ink-secondary)] first:border-t">
                        <Paperclip className="h-4 w-4" />
                        <span className="min-w-0">
                          <span className="block truncate">{attachment.name}</span>
                          <small className="block text-xs text-[var(--ink-subtle)]">{formatBytes(attachment.sizeBytes)}</small>
                        </span>
                        <span
                          ref={downloadTargetAttachmentId === attachment.id ? downloadMenuRef : undefined}
                          className="relative flex items-center gap-1"
                        >
                          <button
                            type="button"
                            disabled={downloadingAttachmentId !== null}
                            onClick={() => requestAttachmentDownload(attachment)}
                            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-55"
                            aria-label={`下载附件 ${attachment.name}`}
                            title={projects.length > 1 ? '选择下载工作区' : '下载附件'}
                          >
                            {downloadingAttachmentId === attachment.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          </button>
                          {downloadTargetAttachmentId === attachment.id && projects.length > 1 && (
                            <div className="absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                              <div className="px-2 pb-1 text-xs font-semibold text-[var(--ink-muted)]">下载到 Agent 工作区</div>
                              {projects.map((project) => (
                                <button
                                  key={project.path}
                                  type="button"
                                  disabled={downloadingAttachmentId !== null}
                                  onClick={() => void downloadAttachment(attachment, project.path)}
                                  className="block h-9 w-full truncate rounded-lg px-2.5 text-left text-sm font-semibold text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-60"
                                >
                                  {project.displayName || project.name || basename(project.path)}
                                </button>
                              ))}
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => void copyAttachmentCommand(attachment)}
                            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                            aria-label={`复制附件下载命令 ${attachment.name}`}
                            title="复制 CLI 下载命令"
                          >
                            <Copy className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            disabled={!downloadedAttachmentPaths[attachment.id]}
                            onClick={() => void copyDownloadedAttachmentPath(attachment)}
                            className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
                            aria-label={`复制附件本地路径 ${attachment.name}`}
                            title="复制本地路径"
                          >
                            <FileText className="h-4 w-4" />
                          </button>
                        </span>
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
                    <div ref={agentMenuRef} className="relative">
                      <button
                        type="button"
                        disabled={registeredAgents.length === 0 || dispatchingAgentId !== null}
                        onClick={() => setAgentMenuOpen((value) => !value)}
                        className="flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      >
                        {dispatchingAgentId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
                        指派 Agent
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      {agentMenuOpen && (
                        <div className="absolute left-0 right-0 top-full z-30 mt-2 max-h-72 overflow-auto rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-1.5 shadow-lg">
                          {registeredAgents.length === 0 ? (
                            <div className="px-3 py-3 text-sm text-[var(--ink-muted)]">暂无 Registered Agent</div>
                          ) : (
                            registeredAgents.map((agent) => (
                              <button
                                key={agent.id}
                                type="button"
                                disabled={dispatchingAgentId !== null || !isRegisteredAgentAssignable(agent)}
                                onClick={() => void assignAgent(agent)}
                                className="grid min-h-12 w-full grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2.5 text-left transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-not-allowed disabled:opacity-55"
                              >
                                <span className="grid h-7 w-7 place-items-center rounded-lg bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">
                                  {dispatchingAgentId === agent.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : initials(agent.displayName)}
                                </span>
                                <span className="min-w-0">
                                  <strong className="block truncate text-sm font-semibold text-[var(--ink)]">{agent.displayName}</strong>
                                  <small className="block truncate text-xs text-[var(--ink-muted)]">{formatRegisteredAgentSecondaryLabel(agent)}</small>
                                </span>
                                {!isRegisteredAgentAssignable(agent) && (
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
