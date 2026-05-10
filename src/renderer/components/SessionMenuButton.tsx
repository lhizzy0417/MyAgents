/**
 * SessionMenuButton — the "⋯" overflow menu for the current chat session.
 *
 * Always visible (as long as a session id exists) so the menu surface is a
 * stable affordance, replacing the conditional handover button shipped in the
 * earlier PRD 0.2.14 cut. All single-session actions previously scattered
 * across the SessionHistoryDropdown row hover state are gathered here:
 *
 *   重命名 / 收藏 / 导出 md / 查看消耗统计 / 绑定聊天机器人 ▸ / ─── / 删除
 *
 * The "绑定聊天机器人" submenu replaces the standalone HandoverPopover and
 * branches on whether the session is currently channel-bound:
 *
 *   - unbound        → list available channels; pick one → handover
 *   - already bound  → "已绑定 X·Y" header + other channels (switch) + 新会话
 *
 * Cron-protected sessions render the delete item as a disabled red row (same
 * tooltip wording as SessionHistoryDropdown).
 */

import { forwardRef, useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
    BarChart2,
    Download,
    Gauge,
    Loader2,
    MessageSquare,
    MoreHorizontal,
    Pencil,
    Star,
    Trash2,
} from 'lucide-react';

import { deleteSession, updateSession, type SessionMetadata } from '@/api/sessionClient';
import { deactivateSession } from '@/api/tauriClient';
import { handoverSessionToChannel } from '@/api/sessionHandoverClient';
import { exportSessionAsMarkdown } from '@/utils/sessionExport';
import type { ChannelSurface } from '@/hooks/useSessionSurfaces';

import ConfirmDialog from './ConfirmDialog';
import SessionStatsModal from './SessionStatsModal';
import Tip from './Tip';
import { useToast } from './Toast';
import { Popover } from './ui/Popover';

const CRON_DELETE_TOOLTIP = '请先停止循环任务后再删除';

export interface BotChannelCandidate {
    agentId: string;
    agentName: string;
    channelId: string;
    channelType: string;
    channelName: string;
    /** Localized platform label, e.g. `飞书` */
    platformLabel: string;
}

export interface SessionMenuButtonProps {
    sessionId: string;
    sessionTitle: string;
    workspacePath: string;
    /** Current binding (null = pure desktop session) */
    boundChannel: ChannelSurface | null;
    /** All online channels for this workspace's Agent — drives the bot submenu. */
    availableChannels: BotChannelCandidate[];
    /** True when a cron task is the running owner — delete must be blocked. */
    cronProtected: boolean;
    /** Current favorite state from sessionMeta. */
    favorite: boolean;
    /** False when the title editor isn't mounted (placeholder titles like
     *  "New Tab" / "New Chat") — disables the 重命名 row to avoid a silent
     *  no-op on a click that promised to open the editor. */
    canRename: boolean;
    /** Open the inline title editor — sourced from a SessionTitleEditor ref. */
    onOpenRename: () => void;
    /**
     * Send the SDK `/context` slash command on behalf of the user so the
     * `/context` output (real token-window distribution) lands in the chat
     * stream. Only wired by the caller when the active runtime is `builtin`
     * — external runtimes (Claude Code CLI / Codex / Gemini) don't share
     * this command surface, so the menu item should hide entirely there.
     * The menu omits the row when this prop is undefined.
     */
    onShowContext?: () => void;
    /** Caller persists the change and updates sessionMeta optimistically. */
    onFavoriteChanged?: (next: boolean, updated: SessionMetadata | null) => void;
    /** Called after a successful delete so caller can reset to a new session. */
    onDeleted: () => void;
}

export default function SessionMenuButton({
    sessionId,
    sessionTitle,
    workspacePath,
    boundChannel,
    availableChannels,
    cronProtected,
    favorite,
    canRename,
    onOpenRename,
    onShowContext,
    onFavoriteChanged,
    onDeleted,
}: SessionMenuButtonProps) {
    const toast = useToast();
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const botMenuItemRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const [submenuOpen, setSubmenuOpen] = useState(false);
    // Snapshot the session id+title at modal-open time so the stats view
    // doesn't silently switch to a different session if the parent tab
    // rotates `sessionId` (e.g. a "+新对话" elsewhere) while the modal is up.
    // Same defensive snapshot as SessionHistoryDropdown's `statsSession`.
    const [statsTarget, setStatsTarget] = useState<{ id: string; title: string } | null>(null);
    const [pendingDelete, setPendingDelete] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [favoriteInFlight, setFavoriteInFlight] = useState(false);
    const [handoverPendingChannelId, setHandoverPendingChannelId] = useState<string | null>(null);

    const closeAll = useCallback(() => {
        setOpen(false);
        setSubmenuOpen(false);
    }, []);

    // ─── Actions ──────────────────────────────────────────────────────────

    const handleRename = useCallback(() => {
        closeAll();
        // Defer to next tick so the popover unmounts (and releases focus
        // to body) before we focus the title input — otherwise the
        // popover's outside-click cleanup races with the input's auto-select.
        setTimeout(onOpenRename, 0);
    }, [closeAll, onOpenRename]);

    const handleToggleFavorite = useCallback(async () => {
        if (favoriteInFlight) return;
        setFavoriteInFlight(true);
        const next = !favorite;
        try {
            const updated = await updateSession(sessionId, { favorite: next });
            if (updated) {
                onFavoriteChanged?.(next, updated);
                toast.success(next ? '已收藏' : '已取消收藏');
            } else {
                toast.error('收藏失败，请重试');
            }
        } catch (err) {
            console.error('[SessionMenuButton] toggle favorite failed:', err);
            toast.error('收藏失败，请重试');
        } finally {
            setFavoriteInFlight(false);
            closeAll();
        }
    }, [favoriteInFlight, favorite, sessionId, onFavoriteChanged, toast, closeAll]);

    const handleExport = useCallback(async () => {
        if (exporting) return;
        setExporting(true);
        try {
            const result = await exportSessionAsMarkdown(sessionId);
            if (result.ok) toast.success(result.message);
            else toast.error(result.message);
        } finally {
            setExporting(false);
            closeAll();
        }
    }, [exporting, sessionId, toast, closeAll]);

    const handleShowStats = useCallback(() => {
        setStatsTarget({ id: sessionId, title: sessionTitle || '此对话' });
        closeAll();
    }, [sessionId, sessionTitle, closeAll]);

    const handleShowContext = useCallback(() => {
        if (!onShowContext) return;
        closeAll();
        onShowContext();
    }, [onShowContext, closeAll]);

    const handleDeleteClick = useCallback(() => {
        if (cronProtected) return;
        closeAll();
        setPendingDelete(true);
    }, [cronProtected, closeAll]);

    const handleConfirmDelete = useCallback(async () => {
        setPendingDelete(false);
        try {
            const ok = await deleteSession(sessionId);
            if (ok) {
                await deactivateSession(sessionId);
                onDeleted();
            } else {
                toast.error('删除失败，请重试');
            }
        } catch (err) {
            console.error('[SessionMenuButton] delete failed:', err);
            toast.error('删除失败，请重试');
        }
    }, [sessionId, onDeleted, toast]);

    // ─── Bot submenu ──────────────────────────────────────────────────────

    const handleHandover = useCallback(async (candidate: BotChannelCandidate) => {
        if (handoverPendingChannelId) return;
        setHandoverPendingChannelId(candidate.channelId);
        try {
            const res = await handoverSessionToChannel({
                sessionId,
                agentId: candidate.agentId,
                channelId: candidate.channelId,
                workspacePath,
            });
            if (res.ok) {
                if (res.notified) {
                    toast.success(`已交接到 ${candidate.platformLabel} · ${candidate.channelName}`);
                } else {
                    // Step 7 (adapter.send_message) failed but the binding
                    // is in place. Surface the partial failure instead of
                    // silently treating it as full success — the user needs
                    // to know the IM end didn't get notified so they can
                    // ping the channel manually if needed. v0.2.14 dogfood
                    // showed silent-fail leading to "did this work?" UX.
                    toast.error(`已交接到 ${candidate.platformLabel} · ${candidate.channelName}，但通知未送达 IM`);
                }
                closeAll();
            } else {
                toast.error('交接失败');
            }
        } catch (err) {
            console.error('[SessionMenuButton] handover failed:', err);
            toast.error(`交接失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setHandoverPendingChannelId(null);
        }
    }, [handoverPendingChannelId, sessionId, workspacePath, toast, closeAll]);

    // Show the bot menu item when we either have channels to bind to OR the
    // session is already bound — otherwise a session bound to a transiently
    // offline channel loses the entire submenu (including "新会话") while the
    // bot is reconnecting, leaving the user no way to act on the binding.
    const showBotItem = !!boundChannel || availableChannels.length > 0;
    const otherChannels = boundChannel
        ? availableChannels.filter((c) => c.channelId !== boundChannel.channelId)
        : availableChannels;

    return (
        <>
            <Tip label="对话操作" position="bottom">
                <button
                    ref={triggerRef}
                    type="button"
                    aria-label="对话操作"
                    aria-expanded={open}
                    aria-haspopup="menu"
                    onClick={() => setOpen((prev) => !prev)}
                    className={`flex h-7 w-7 items-center justify-center rounded-md transition-colors ${
                        open
                            ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                            : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]'
                    }`}
                >
                    <MoreHorizontal className="h-4 w-4" />
                </button>
            </Tip>

            <Popover
                open={open}
                onClose={closeAll}
                anchorRef={triggerRef}
                placement="bottom-start"
                offset={6}
                className="w-56 py-1"
            >
                <MenuItem
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    label="重命名"
                    onClick={canRename ? handleRename : undefined}
                    disabled={!canRename}
                    title={canRename ? undefined : '发送一条消息后再为对话命名'}
                />
                <MenuItem
                    icon={<Star className="h-3.5 w-3.5" fill={favorite ? 'currentColor' : 'none'} />}
                    label={favorite ? '取消收藏' : '收藏对话'}
                    onClick={() => { void handleToggleFavorite(); }}
                    disabled={favoriteInFlight}
                />
                <MenuItem
                    icon={exporting
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Download className="h-3.5 w-3.5" />}
                    label="导出为 md 文件"
                    onClick={() => { void handleExport(); }}
                    disabled={exporting}
                />
                <MenuItem
                    icon={<BarChart2 className="h-3.5 w-3.5" />}
                    label="会话 Token 消耗统计"
                    onClick={handleShowStats}
                />
                {onShowContext && (
                    <MenuItem
                        icon={<Gauge className="h-3.5 w-3.5" />}
                        label="上下文 Token 使用详情"
                        onClick={handleShowContext}
                    />
                )}
                {showBotItem && (
                    <MenuItem
                        ref={botMenuItemRef}
                        icon={<MessageSquare className="h-3.5 w-3.5" />}
                        label="绑定聊天机器人"
                        trailing={<span className="text-[var(--ink-subtle)]">▸</span>}
                        onClick={() => setSubmenuOpen((prev) => !prev)}
                        active={submenuOpen}
                    />
                )}
                <div className="my-1 border-t border-[var(--line-subtle)]" />
                {/* macOS WebKit doesn't reliably surface `title` on a
                 *  disabled button, so when the row is cron-protected we
                 *  put the tooltip on a wrapping span (which still receives
                 *  hover) and keep the button purely disabled. */}
                {cronProtected ? (
                    <span className="block" title={CRON_DELETE_TOOLTIP}>
                        <MenuItem
                            icon={<Trash2 className="h-3.5 w-3.5" />}
                            label="删除对话"
                            disabled
                            tone="danger"
                        />
                    </span>
                ) : (
                    <MenuItem
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        label="删除对话"
                        onClick={handleDeleteClick}
                        tone="danger"
                    />
                )}
            </Popover>

            {/* Bot submenu — anchored to the menu item so it floats to the side. */}
            {showBotItem && (
                <Popover
                    open={open && submenuOpen}
                    onClose={() => setSubmenuOpen(false)}
                    anchorRef={botMenuItemRef}
                    placement="right-start"
                    offset={6}
                    className="w-64 py-1"
                    zIndex={261}
                >
                    {boundChannel ? (
                        <>
                            {/* Bound row mirrors the candidate-row layout
                             *  (`<platform> · <bot>`) with a trailing
                             *  "已绑定" tag instead of a click target — same
                             *  visual rhythm as the unselected options, just
                             *  in the selected state. */}
                            <div
                                aria-disabled
                                className="flex w-full cursor-default items-center gap-2 px-3 py-2 text-left text-[12px]"
                            >
                                <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
                                <span className="shrink-0 font-medium text-[var(--ink)]">{boundChannel.platformLabel}</span>
                                <span className="shrink-0 text-[var(--ink-subtle)]">·</span>
                                <span className="min-w-0 flex-1 truncate text-[var(--ink-muted)]">
                                    {boundChannel.channelName}
                                </span>
                                <span className="shrink-0 rounded-sm bg-[var(--paper-inset)] px-1.5 py-0.5 text-[10px] text-[var(--ink-muted)]">
                                    已绑定
                                </span>
                            </div>
                            {otherChannels.length > 0 && (
                                <>
                                    <div className="my-1 border-t border-[var(--line-subtle)]" />
                                    <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-[var(--ink-subtle)]">
                                        切换到其他
                                    </div>
                                    {otherChannels.map((c) => (
                                        <ChannelMenuItem
                                            key={c.channelId}
                                            candidate={c}
                                            pending={handoverPendingChannelId === c.channelId}
                                            disabled={handoverPendingChannelId !== null}
                                            onClick={() => { void handleHandover(c); }}
                                        />
                                    ))}
                                </>
                            )}
                        </>
                    ) : (
                        availableChannels.map((c) => (
                            <ChannelMenuItem
                                key={c.channelId}
                                candidate={c}
                                pending={handoverPendingChannelId === c.channelId}
                                disabled={handoverPendingChannelId !== null}
                                onClick={() => { void handleHandover(c); }}
                            />
                        ))
                    )}
                </Popover>
            )}

            {/* Stats modal — portal to document.body to escape the chat header's
             *  z-10 stacking context, otherwise the side workspace panel
             *  (rendered as a sibling of the chat content) paints over the
             *  fixed-position OverlayBackdrop. Same fix SessionHistoryDropdown
             *  applies for the same reason. */}
            {statsTarget && createPortal(
                <SessionStatsModal
                    sessionId={statsTarget.id}
                    sessionTitle={statsTarget.title}
                    onClose={() => setStatsTarget(null)}
                />,
                document.body,
            )}

            {/* Delete confirm */}
            {pendingDelete && (
                <ConfirmDialog
                    title="删除对话"
                    message={`确定要删除「${sessionTitle || '此对话'}」吗？此操作不可撤销。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    onConfirm={handleConfirmDelete}
                    onCancel={() => setPendingDelete(false)}
                />
            )}
        </>
    );
}

// ============================================================================
// Internal building blocks
// ============================================================================

interface MenuItemProps {
    icon: React.ReactNode;
    label: string;
    trailing?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    active?: boolean;
    tone?: 'default' | 'danger';
    /** Native browser tooltip — used for the disabled cron-protected delete row. */
    title?: string;
}

const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
    { icon, label, trailing, onClick, disabled = false, active = false, tone = 'default', title },
    ref,
) {
    const toneClass = tone === 'danger'
        ? 'text-[var(--error)] hover:bg-[var(--error-bg)]'
        : 'text-[var(--ink)] hover:bg-[var(--hover-bg)]';
    return (
        <button
            ref={ref}
            type="button"
            disabled={disabled}
            onClick={onClick}
            title={title}
            className={`flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass} ${
                active ? 'bg-[var(--paper-inset)]' : ''
            }`}
        >
            <span className={tone === 'danger' ? 'text-[var(--error)]' : 'text-[var(--ink-muted)]'}>{icon}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {trailing}
        </button>
    );
});

interface ChannelMenuItemProps {
    candidate: BotChannelCandidate;
    pending: boolean;
    disabled: boolean;
    onClick: () => void;
}

function ChannelMenuItem({ candidate, pending, disabled, onClick }: ChannelMenuItemProps) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-[var(--hover-bg)] disabled:cursor-not-allowed disabled:opacity-50"
        >
            <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--success)]" />
            <span className="shrink-0 font-medium text-[var(--ink)]">{candidate.platformLabel}</span>
            <span className="shrink-0 text-[var(--ink-subtle)]">·</span>
            <span className="min-w-0 flex-1 truncate text-[var(--ink-muted)]">
                {candidate.channelName}
            </span>
            {pending && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--ink-muted)]" />}
        </button>
    );
}
