/**
 * RecentTasks — Dual-tab mini view: 历史会话 (Chat sessions) | 我的任务 (Tasks).
 *
 * v0.1.69 UX consolidation: the old panel split Chat sessions + legacy CronTasks;
 * v0.1.69 introduced the Task entity as the unified schedule-bearing concept.
 * This panel now reads new-model `Task[]` for the right tab so "启动页" agrees
 * with "任务中心" on the same source of truth. Legacy CronTasks ineligible for
 * auto-migration stay in the Task Center's "遗留" view only.
 */

import { memo, useCallback, useMemo, useState } from 'react';
import { AlertCircle, ArrowRight, BarChart2, Clock, Folder, MessageSquare, Plus, RefreshCw, Sparkles, Trash2, Search } from 'lucide-react';

import type { TaskCenterData } from '@/hooks/useTaskCenterData';
import WorkspaceIcon from './WorkspaceIcon';
import SessionTagBadge from '@/components/SessionTagBadge';
import SessionStatsModal from '@/components/SessionStatsModal';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { getFolderName, formatTime, getSessionDisplayText, formatMessageCount, relativeTime } from '@/utils/taskCenterUtils';
import { normalizeWorkspacePathIdentity, workspacePathsEqual } from '@/../shared/workspacePath';
import type { SessionMetadata } from '@/api/sessionClient';
import type { TaskStatus } from '@/../shared/types/task';
import type { Project } from '@/config/types';
import { DispatchTaskDialog } from '@/components/task-center/DispatchTaskDialog';
import { CUSTOM_EVENTS } from '@/../shared/constants';

const DISPLAY_COUNT = 5;
/** Tasks tab shows one fewer item because the "新建任务" button takes one row's worth of height */
const TASKS_DISPLAY_COUNT = 4;
/** Fixed min-height for 5 rows (each ~36px + 2px gap) to prevent layout shift */
const LIST_MIN_HEIGHT = 'min-h-[188px]';

interface RecentTasksProps {
    projects: Project[];
    onOpenTask: (session: SessionMetadata, project: Project) => void;
    /** "全部 →" / "搜索" buttons on the sessions tab — opens the session-history overlay. */
    onOpenOverlay: (mode?: 'default' | 'search') => void;
    taskCenterData: TaskCenterData;
}

type ActiveTab = 'sessions' | 'tasks';

// Map new-model Task statuses to a compact label + tint that parallels the old
// `getCronStatusText` / `getCronStatusColor` helpers so this row's visual
// vocabulary doesn't change dramatically across the tab switch.
const TASK_STATUS_STYLE: Record<TaskStatus, { label: string; className: string }> = {
    todo: { label: '待启动', className: 'text-[var(--ink-muted)]' },
    running: { label: '进行中', className: 'text-[var(--success)]' },
    verifying: { label: '验证中', className: 'text-[var(--accent-warm)]' },
    blocked: { label: '受阻', className: 'text-[var(--warning)]' },
    stopped: { label: '已暂停', className: 'text-[var(--ink-muted)]/70' },
    done: { label: '已完成', className: 'text-[var(--ink-muted)]/60' },
    archived: { label: '已归档', className: 'text-[var(--ink-muted)]/50' },
    deleted: { label: '已删除', className: 'text-[var(--ink-muted)]/40' },
};

export default memo(function RecentTasks({
    projects,
    onOpenTask,
    onOpenOverlay,
    taskCenterData,
}: RecentTasksProps) {
    const { sessions, cronTasks, tasks, sessionTagsMap, isLoading, error, refresh, actions } = taskCenterData;
    const toast = useToast();

    const [activeTab, setActiveTab] = useState<ActiveTab>('sessions');
    const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | null>(null);
    const [statsSession, setStatsSession] = useState<{ id: string; title: string } | null>(null);
    const [showCreateModal, setShowCreateModal] = useState(false);

    // Top 5 sessions — filter to those with a matching visible project first, then slice
    const displaySessions = useMemo(() => {
        // Key membership by canonical identity — project.path keeps the native
        // Windows form (backslashes) while session.agentDir is POSIX-style, so a
        // raw Set.has(agentDir) dropped every session on Windows (#320).
        const projectPaths = new Set(projects.map(p => normalizeWorkspacePathIdentity(p.path)));
        return sessions.filter(s => projectPaths.has(normalizeWorkspacePathIdentity(s.agentDir))).slice(0, DISPLAY_COUNT);
    }, [sessions, projects]);

    // "我的任务" tab: all Task statuses, sorted by updatedAt desc, take the
    // top 4 (5th slot reserved for the "+ 新建任务" affordance). We
    // deliberately include `done` / `archived` rows so users see the
    // full shape of their recent work; `deleted` is dropped because a
    // deleted task is never something the user wants to navigate to.
    const displayTasks = useMemo(() => {
        return tasks
            .filter((t) => t.status !== 'deleted')
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, TASKS_DISPLAY_COUNT);
    }, [tasks]);

    const getProjectForSession = useCallback(
        (session: SessionMetadata): Project | undefined =>
            projects.find(p => workspacePathsEqual(p.path, session.agentDir)),
        [projects]
    );

    // A session that backs a running cron is "protected" from delete —
    // still computed from `cronTasks` (the cron scheduler owns the
    // session lifecycle) even though the right-hand tab no longer
    // shows cron rows.
    const cronProtectedSessionIds = useMemo(
        () => new Set(cronTasks.filter(t => t.status === 'running').map(t => t.sessionId)),
        [cronTasks]
    );

    const handleDeleteClick = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setPendingDeleteSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleConfirmDelete = useCallback(async () => {
        if (!pendingDeleteSession) return;
        const { id } = pendingDeleteSession;
        setPendingDeleteSession(null);
        try {
            const success = await actions.deleteSession(id);
            if (success) {
                toast.success('已删除');
            } else {
                toast.error('删除失败，请重试');
            }
        } catch (err) {
            console.error('[RecentTasks] Delete session failed:', err);
            toast.error('删除失败');
        }
    }, [actions, pendingDeleteSession, toast]);

    const handleShowStats = useCallback((e: React.MouseEvent, session: SessionMetadata) => {
        e.stopPropagation();
        setStatsSession({ id: session.id, title: getSessionDisplayText(session) });
    }, []);

    const handleTabChange = useCallback((tab: ActiveTab) => {
        setActiveTab(tab);
        refresh(tab === 'sessions' ? 'sessions' : 'tasks', {
            force: true,
            reason: 'recent-tasks-tab-change',
            silent: true,
        });
    }, [refresh]);

    const handleCreated = useCallback(() => {
        refresh('all', { force: true, reason: 'recent-tasks-task-created', silent: true });
    }, [refresh]);

    // "全部 →" / 搜索 buttons on the 「我的任务」 tab navigate to the Task
    // Center singleton tab instead of opening the session-history
    // overlay. `autofocusSearch` is only set by the search-icon path
    // (v0.1.69 UX decision: clicking 🔍 should drop the user straight
    // into typing mode, not force a second click inside the tab).
    const handleOpenTaskCenter = useCallback((mode: 'default' | 'search' = 'default') => {
        window.dispatchEvent(
            new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER, {
                detail: mode === 'search' ? { autofocusSearch: true } : undefined,
            }),
        );
    }, []);

    const handleRetry = useCallback(() => {
        refresh('all', { force: true, reason: 'recent-tasks-retry' });
    }, [refresh]);

    if (isLoading) {
        return (
            <div className="mb-8">
                <TabHeader activeTab={activeTab} onTabChange={handleTabChange} onOpenOverlay={onOpenOverlay} onOpenTaskCenter={handleOpenTaskCenter} />
                <div className={`${LIST_MIN_HEIGHT} flex items-center`}>
                    <div className="py-4 text-[13px] text-[var(--ink-muted)]/70">加载中...</div>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="mb-8">
                <TabHeader activeTab={activeTab} onTabChange={handleTabChange} onOpenOverlay={onOpenOverlay} onOpenTaskCenter={handleOpenTaskCenter} />
                <div className={`${LIST_MIN_HEIGHT} flex items-center justify-center`}>
                    <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                        <AlertCircle className="mx-auto mb-2 h-4 w-4 text-amber-500/70" />
                        <p className="mb-2 text-[13px] text-[var(--ink-muted)]">{error}</p>
                        <button
                            onClick={handleRetry}
                            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
                        >
                            <RefreshCw className="h-3.5 w-3.5" />
                            重试
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="mb-8">
            <TabHeader activeTab={activeTab} onTabChange={handleTabChange} onOpenOverlay={onOpenOverlay} onOpenTaskCenter={handleOpenTaskCenter} />

            {/* Sessions tab */}
            {activeTab === 'sessions' && (
                <div className={LIST_MIN_HEIGHT}>
                    {displaySessions.length === 0 ? (
                        <div className={`${LIST_MIN_HEIGHT} flex items-center justify-center`}>
                            <div className="rounded-xl border border-dashed border-[var(--line)] px-4 py-5 text-center">
                                <MessageSquare className="mx-auto mb-2 h-4 w-4 text-[var(--ink-muted)]/50" />
                                <p className="text-[13px] text-[var(--ink-muted)]/70">暂无对话记录</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {displaySessions.map(session => {
                                const project = getProjectForSession(session);
                                if (!project) return null;
                                const tags = sessionTagsMap.get(session.id) ?? [];
                                const displayText = getSessionDisplayText(session);
                                const msgCount = formatMessageCount(session);

                                const isCronProtected = cronProtectedSessionIds.has(session.id);
                                return (
                                    <div
                                        key={session.id}
                                        role="button"
                                        onClick={() => onOpenTask(session, project)}
                                        className="group relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
                                    >
                                        <div className="flex w-14 shrink-0 items-center gap-1 text-[11px] text-[var(--ink-muted)]/50">
                                            <Clock className="h-2.5 w-2.5" />
                                            <span>{formatTime(session.lastActiveAt)}</span>
                                        </div>
                                        {tags.map((tag, i) => (
                                            <SessionTagBadge key={i} tag={tag} />
                                        ))}
                                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                            {displayText}
                                            {msgCount && (
                                                <span className="ml-1.5 text-[11px] text-[var(--ink-muted)]/40">
                                                    {msgCount}
                                                </span>
                                            )}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--ink-muted)]/45">
                                            <WorkspaceIcon icon={project.icon} size={14} />
                                            <span className="max-w-[80px] truncate">
                                                {getFolderName(project.path)}
                                            </span>
                                        </div>

                                        {/* Hover actions overlay */}
                                        <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                                            <div className="h-full w-10 bg-gradient-to-r from-transparent to-[var(--paper-inset)]" />
                                            <div className="flex h-full items-center gap-1 bg-[var(--paper-inset)] pr-3">
                                                <button
                                                    onClick={e => handleShowStats(e, session)}
                                                    title="查看统计"
                                                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper)] hover:text-[var(--ink)]"
                                                >
                                                    <BarChart2 className="h-3.5 w-3.5" />
                                                </button>
                                                {isCronProtected ? (
                                                    <button
                                                        disabled
                                                        title="请先停止定时任务后再删除"
                                                        className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-md text-[var(--ink-muted)] opacity-40"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                ) : (
                                                    <button
                                                        onClick={e => handleDeleteClick(e, session)}
                                                        title="删除"
                                                        className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--ink-muted)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)]"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* 「我的任务」 tab — snapshot of the Task Center's task list,
                 sorted by updatedAt desc. Clicking a row (or "全部 →")
                 jumps to the full Task Center tab; this surface is
                 read-only, per-row edit affordances live in the Task
                 Center. */}
            {activeTab === 'tasks' && (
                <div className={LIST_MIN_HEIGHT}>
                    {/* "+ 新建任务" — opens the blank-state DispatchTaskDialog
                         (default executionMode = once). The Task Center's
                         TaskListPanel header carries the same entry so
                         both surfaces agree on the "+" semantics. */}
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="mb-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--line)] py-2 text-[13px] font-medium text-[var(--ink-muted)] hover:border-[var(--line-strong)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        新建任务
                    </button>
                    {displayTasks.length === 0 ? (
                        <div className="flex items-center justify-center py-6">
                            <div className="text-center">
                                <Sparkles className="mx-auto mb-2 h-4 w-4 text-[var(--ink-muted)]/50" />
                                <p className="text-[13px] text-[var(--ink-muted)]/70">暂无任务</p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-0.5">
                            {displayTasks.map(task => {
                                // TypeScript's exhaustiveness check covers the compile-time
                                // `TaskStatus` union, but on-disk Task records can be ahead
                                // of the types (e.g. a new backend status rolled out before
                                // a renderer update). Fall back to the raw string instead of
                                // misrepresenting it as "待启动", which would hide the fact
                                // that the app doesn't know what the task is doing.
                                // (v0.1.69 cross-review N1)
                                const style =
                                    TASK_STATUS_STYLE[task.status] ??
                                    ({ label: String(task.status), className: 'text-[var(--ink-muted)]/50' } as const);
                                const workspaceName = getFolderName(task.workspacePath ?? '');
                                return (
                                    <button
                                        key={task.id}
                                        onClick={() => handleOpenTaskCenter('default')}
                                        className="group flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-all hover:bg-[var(--hover-bg)]"
                                    >
                                        <span
                                            className={`w-14 shrink-0 text-[11px] font-medium ${style.className}`}
                                        >
                                            {style.label}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink-secondary)] transition-colors group-hover:text-[var(--ink)]">
                                            {task.name || '未命名任务'}
                                        </span>
                                        <div className="flex shrink-0 items-center gap-2 text-[11px] text-[var(--ink-muted)]/50">
                                            <span className="inline-flex items-center gap-1">
                                                <Folder className="h-2.5 w-2.5" strokeWidth={1.5} />
                                                <span className="max-w-[80px] truncate">{workspaceName}</span>
                                            </span>
                                            <span>{relativeTime(task.updatedAt)}</span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}

            {pendingDeleteSession && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定要删除「${pendingDeleteSession.title}」吗？此操作不可撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDeleteSession(null)}
                />
            )}
            {statsSession && (
                <SessionStatsModal
                    sessionId={statsSession.id}
                    sessionTitle={statsSession.title}
                    onClose={() => setStatsSession(null)}
                />
            )}
            {showCreateModal && (
                <DispatchTaskDialog
                    onClose={() => setShowCreateModal(false)}
                    onDispatched={() => {
                        setShowCreateModal(false);
                        handleCreated();
                    }}
                />
            )}
        </div>
    );
});

// Tab header sub-component.
//
// The 全部/搜索 buttons route differently by active tab (v0.1.69 UX round):
//   - 「历史会话」 tab → `onOpenOverlay` (session-history overlay, unchanged)
//   - 「我的任务」 tab → `onOpenTaskCenter` (dispatches OPEN_TASK_CENTER so
//     the Task Center singleton tab handles navigation + optional search
//     auto-focus)
function TabHeader({
    activeTab,
    onTabChange,
    onOpenOverlay,
    onOpenTaskCenter,
}: {
    activeTab: ActiveTab;
    onTabChange: (t: ActiveTab) => void;
    onOpenOverlay: (mode?: 'default' | 'search') => void;
    onOpenTaskCenter: (mode?: 'default' | 'search') => void;
}) {
    const handleSearch = () => {
        if (activeTab === 'tasks') onOpenTaskCenter('search');
        else onOpenOverlay('search');
    };
    const handleSeeAll = () => {
        if (activeTab === 'tasks') onOpenTaskCenter('default');
        else onOpenOverlay('default');
    };
    const searchTitle = activeTab === 'tasks' ? '搜索任务' : '搜索历史对话';
    return (
        <div className="mb-3 flex items-center justify-between">
            <div className="flex gap-4">
                <button
                    onClick={() => onTabChange('sessions')}
                    className={`relative text-[13px] font-semibold tracking-[0.04em] transition-colors ${
                        activeTab === 'sessions'
                            ? 'text-[var(--ink-muted)]'
                            : 'text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)]'
                    }`}
                >
                    历史对话
                    {activeTab === 'sessions' && (
                        <div className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full bg-[var(--accent)]" />
                    )}
                </button>
                <button
                    onClick={() => onTabChange('tasks')}
                    className={`relative text-[13px] font-semibold tracking-[0.04em] transition-colors ${
                        activeTab === 'tasks'
                            ? 'text-[var(--ink-muted)]'
                            : 'text-[var(--ink-muted)]/60 hover:text-[var(--ink-muted)]'
                    }`}
                >
                    我的任务
                    {activeTab === 'tasks' && (
                        <div className="absolute -bottom-1 left-0 right-0 h-[2px] rounded-full bg-[var(--accent)]" />
                    )}
                </button>
            </div>

            <div className="flex items-center gap-1">
                <button
                    onClick={handleSearch}
                    className="flex h-6 w-6 items-center justify-center rounded p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title={searchTitle}
                >
                    <Search className="h-3.5 w-3.5" />
                </button>
                <button
                    onClick={handleSeeAll}
                    className="group flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                    全部
                    <ArrowRight className="h-3 w-3 opacity-60 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" />
                </button>
            </div>
        </div>
    );
}
