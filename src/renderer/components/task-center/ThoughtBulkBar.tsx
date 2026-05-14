// ThoughtBulkBar — bottom-of-panel floating action bar for multi-select
// mode in the Task Center 想法 panel. Shows when `selectMode` is true.
//
// Positioned `absolute` (NOT `fixed`) so it docks to the bottom of the
// thought panel rather than the viewport. Its parent (ThoughtPanel root)
// is `relative` for that anchoring. This keeps the bar over the thought
// list only — without overlapping the right-hand task list — and follows
// the panel when it scrolls into view, instead of always sitting at the
// screen center where it would crowd unrelated UI.
//
// Sits at z-40 so it floats above the card list but below full-screen
// overlays (e.g. DispatchTaskDialog at z-[200]) and the global toast/modal
// stack at z-[300]. The container uses `pointer-events-none` so the
// surrounding gutter doesn't swallow clicks targeted at the cards behind
// it; the inner pill takes pointer events back on for its buttons.

import { Archive, ArchiveRestore, Layers, Trash2, X } from 'lucide-react';

interface Props {
  /** Number of currently selected thoughts. Drives merge/delete enable state. */
  count: number;
  /** Click 「合并」 — only fires when `count >= 2`. */
  onMerge: () => void;
  /** Click 「归档」/「取消归档」 — flips archive flag for every selected thought. */
  onArchive: () => void;
  /** Click 「删除」 — opens a confirm dialog at the panel level. Only fires
   *  when `count >= 1`. */
  onDelete: () => void;
  /** Click 「取消」 — exit selectMode and clear selection. */
  onCancel: () => void;
  /** Current panel view mode — drives archive button label / icon. */
  viewMode: 'active' | 'archived';
  /** When true, action buttons are disabled (e.g. during merge/delete RPC). */
  busy?: boolean;
}

export function ThoughtBulkBar({
  count,
  onMerge,
  onArchive,
  onDelete,
  onCancel,
  viewMode,
  busy,
}: Props) {
  const canMerge = count >= 2 && !busy;
  const canArchive = count >= 1 && !busy;
  const canDelete = count >= 1 && !busy;
  const archiveLabel = viewMode === 'archived' ? '取消归档' : '归档';
  const ArchiveIcon = viewMode === 'archived' ? ArchiveRestore : Archive;
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-40 flex justify-center">
      <div
        className="pointer-events-auto flex items-center gap-1 rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1.5 shadow-lg"
        role="toolbar"
        aria-label="想法多选操作"
      >
        <span className="px-3 text-[12px] tabular-nums text-[var(--ink-muted)]">
          已选 {count}
        </span>
        <div className="h-5 w-px bg-[var(--line)]" />
        <button
          type="button"
          onClick={onMerge}
          disabled={!canMerge}
          title={count < 2 ? '至少选择 2 条想法' : '合并选中的想法为一条'}
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--accent-warm-subtle)] hover:text-[var(--accent-warm)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-secondary)]"
        >
          <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
          合并
        </button>
        <button
          type="button"
          onClick={onArchive}
          disabled={!canArchive}
          title={viewMode === 'archived' ? '取消归档选中的想法' : '归档选中的想法'}
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-secondary)]"
        >
          <ArchiveIcon className="h-3.5 w-3.5" strokeWidth={1.75} />
          {archiveLabel}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!canDelete}
          title="删除选中的想法"
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-[var(--ink-secondary)] transition-colors hover:bg-[var(--error-bg)] hover:text-[var(--error)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-[var(--ink-secondary)]"
        >
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
          删除
        </button>
        <div className="h-5 w-px bg-[var(--line)]" />
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          title="退出多选模式"
          className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          取消
        </button>
      </div>
    </div>
  );
}

export default ThoughtBulkBar;
