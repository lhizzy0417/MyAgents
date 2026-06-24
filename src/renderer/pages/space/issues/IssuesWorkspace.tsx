import { useEffect, useState } from 'react';
import { Activity, Hash, Loader2, Plus, RefreshCw, Search, Send, Settings } from 'lucide-react';

import type { SpaceEvent, SpaceIssue, SpaceTag } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { issueStatusLabel } from '@/pages/space/spaceHelpers';
import { recordSpaceMetric } from '@/pages/space/spaceMetrics';
import { formatTime, statusPillClass } from '@/pages/space/spaceUi';

const STATUS_FILTER_OPTIONS: SelectOption[] = [
  { value: '', label: '全部状态' },
  { value: 'open', label: 'Open' },
  { value: 'triaged', label: 'Triaged' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
];

export function IssuesWorkspace({
  admin,
  issues,
  issuesLoading,
  issueMetrics,
  events,
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
  events: SpaceEvent[];
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
  useEffect(() => {
    recordSpaceMetric('space_issue_list_render_count', { count: issues.length });
  }, [issues.length]);

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
        {admin ? <IssueOverviewMenu issueMetrics={issueMetrics} tags={tags} events={events} /> : <span />}
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
                <div className="text-center">
                  <p>暂无匹配 Issue</p>
                  {admin && (
                    <button
                      type="button"
                      onClick={onCreate}
                      className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                    >
                      <Plus className="h-4 w-4" />
                      新建 Issue
                    </button>
                  )}
                </div>
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
  events,
}: {
  issueMetrics: { open: number; inProgress: number; total: number };
  tags: SpaceTag[];
  events: SpaceEvent[];
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
        管理
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
              Space 管理
            </h2>
          </div>
          <div className="px-3.5 py-3">
            <MetricRow label="Open issues" value={issueMetrics.open} />
            <MetricRow label="Assigned to agents" value={issueMetrics.inProgress} />
            <MetricRow label="Waiting dispatch" value={Math.max(0, issueMetrics.open - issueMetrics.inProgress)} />
            <div className="mt-3 border-t border-[var(--line-subtle)] pt-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--ink-muted)]">审计记录</h3>
                <span className="text-xs font-semibold text-[var(--ink-subtle)]">{events.length}</span>
              </div>
              <div className="max-h-44 overflow-auto">
                {events.length === 0 ? (
                  <div className="py-2 text-xs text-[var(--ink-muted)]">暂无记录</div>
                ) : (
                  events.slice(-6).reverse().map((event) => (
                    <div key={event.id} className="grid grid-cols-[18px_minmax(0,1fr)] gap-2 border-b border-dashed border-[var(--line-subtle)] py-2 last:border-b-0">
                      <Activity className="mt-0.5 h-3.5 w-3.5 text-[var(--ink-muted)]" />
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-[var(--ink-secondary)]">{event.type}</span>
                        <span className="block truncate text-xs text-[var(--ink-subtle)]">
                          {[event.resourceType, event.resourceId, formatTime(event.createdAt)].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
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
