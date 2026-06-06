import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { Components, ContextProp } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";

import { runAfterNextPaint } from "@/utils/afterPaint";
import { WorkspaceTreeRow } from "./WorkspaceTreeRow";
import { WorkspaceTreeStickyAncestors } from "./WorkspaceTreeStickyAncestors";
import {
  MAX_STICKY_ANCESTOR_DEPTH,
  resolveStickyAncestors,
} from "./treeFlatten";
import type { StickyAncestor, VisibleTreeRow } from "./treeTypes";

// Reveal waits this many frames for react-virtuoso's scroller to finish layout
// before giving up. scrollToIndex no-ops on an unmeasured scroller, which is
// exactly the state right after the conditional (search→tree) mount.
const REVEAL_READINESS_MAX_FRAMES = 20;

interface ViewportContext {
  stickyHeight: number;
  footerHeight: number;
}

const TreeHeaderSpacer = memo(function TreeHeaderSpacer({
  context,
}: ContextProp<ViewportContext>) {
  if (context.stickyHeight <= 0) {
    return null;
  }
  return <div aria-hidden="true" style={{ height: context.stickyHeight }} />;
});

// Complement of the sticky header. Header + footer always sum to a CONSTANT
// `MAX_STICKY_ANCESTOR_DEPTH * rowHeight`, so the total scroll-content height
// never changes as the breadcrumb grows/shrinks. That keeps `maxScroll` fixed,
// which is what makes the bottom flicker-free (the bottom previously had no
// scroll slack, so header-height changes perturbed the pinned scroll position).
// The reserved bottom space also lets the last rows scroll clear of the sticky
// bar, mirroring an editor's "scroll beyond last line".
const TreeFooterSpacer = memo(function TreeFooterSpacer({
  context,
}: ContextProp<ViewportContext>) {
  if (context.footerHeight <= 0) {
    return null;
  }
  return <div aria-hidden="true" style={{ height: context.footerHeight }} />;
});

const TREE_COMPONENTS: Components<VisibleTreeRow, ViewportContext> = {
  Header: TreeHeaderSpacer,
  Footer: TreeFooterSpacer,
};

interface WorkspaceTreeViewportProps {
  rows: VisibleTreeRow[];
  rowHeight: number;
  dropTargetPath: string | null;
  internalDropTarget: string | null;
  activeDragPaths: readonly string[];
  initialScrollTop?: number;
  revealRequest?: { id: number; path: string } | null;
  onRevealHandled?: (id: number) => void;
  getStickyAncestors: (
    firstVisibleIndex: number,
    scrollTop: number,
  ) => StickyAncestor[];
  onCloseAncestorPath: (path: string) => void;
  onRowClick: (row: VisibleTreeRow, event: React.MouseEvent) => void;
  onRowContextMenu: (row: VisibleTreeRow, event: React.MouseEvent) => void;
  onRowDragEnter: (event: React.DragEvent, row: VisibleTreeRow) => void;
  onRowDragLeave: (event: React.DragEvent, row: VisibleTreeRow) => void;
  onScrollTopChange?: (scrollTop: number) => void;
}

export const WorkspaceTreeViewport = memo(function WorkspaceTreeViewport({
  rows,
  rowHeight,
  dropTargetPath,
  internalDropTarget,
  activeDragPaths,
  initialScrollTop = 0,
  revealRequest = null,
  onRevealHandled,
  getStickyAncestors,
  onCloseAncestorPath,
  onRowClick,
  onRowContextMenu,
  onRowDragEnter,
  onRowDragLeave,
  onScrollTopChange,
}: WorkspaceTreeViewportProps) {
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
    null,
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const lastRevealRequestIdRef = useRef<number | null>(null);
  // Live element ref (read inside async rAF callbacks without a stale closure).
  const scrollerElRef = useRef<HTMLElement | null>(null);
  // Latest rows, so a deferred reveal recomputes its index after a
  // non-idempotent refresh may have reordered the list mid-flight.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  // Cancel handle for an in-flight (deferred) reveal scroll.
  const revealCancelRef = useRef<(() => void) | null>(null);
  // initialScrollTop is a restore-on-mount, applied at most once (when the
  // scroller first attaches). Re-applying on later prop churn could clobber a
  // reveal scroll that just landed.
  const didRestoreScrollRef = useRef(false);

  useEffect(() => {
    if (!scrollerElement || didRestoreScrollRef.current) {
      return;
    }
    didRestoreScrollRef.current = true;
    // A pending reveal owns the scroll position — don't fight it with a restore.
    if (initialScrollTop > 0 && !revealRequest) {
      scrollerElement.scrollTo({ top: initialScrollTop });
    }
  }, [initialScrollTop, revealRequest, scrollerElement]);

  // Cancel any in-flight reveal rAF on unmount.
  useEffect(() => () => revealCancelRef.current?.(), []);

  useEffect(() => {
    if (!scrollerElement) {
      return;
    }

    const handleScroll = () => {
      const nextScrollTop = scrollerElement.scrollTop;
      setScrollTop(nextScrollTop);
      onScrollTopChange?.(nextScrollTop);
    };

    handleScroll();
    scrollerElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      scrollerElement.removeEventListener("scroll", handleScroll);
    };
  }, [onScrollTopChange, scrollerElement]);

  // Sticky breadcrumb derived purely from the (now stable) scroll position —
  // never from Virtuoso's rendered range, which is both a feedback variable and
  // offset from the visual top by the overscan. See `resolveStickyAncestors`.
  const stickyAncestors = useMemo(
    () =>
      resolveStickyAncestors(
        scrollTop,
        rowHeight,
        MAX_STICKY_ANCESTOR_DEPTH,
        (firstVisibleIndex) => getStickyAncestors(firstVisibleIndex, scrollTop),
      ),
    [getStickyAncestors, rowHeight, scrollTop],
  );
  const context = useMemo<ViewportContext>(
    () => ({
      stickyHeight: stickyAncestors.length * rowHeight,
      footerHeight:
        Math.max(0, MAX_STICKY_ANCESTOR_DEPTH - stickyAncestors.length) *
        rowHeight,
    }),
    [rowHeight, stickyAncestors.length],
  );

  const handleScrollerRef = useCallback((element: HTMLElement | null | Window) => {
    const el = element instanceof HTMLElement ? element : null;
    scrollerElRef.current = el;
    setScrollerElement(el);
  }, []);

  // Scroll a requested path into view. The tree is conditionally rendered
  // (search ↔ tree), so a reveal coincides with a FRESH MOUNT of this Virtuoso,
  // whose scroller isn't measured yet during this mount-time effect —
  // `scrollToIndex` silently no-ops there. The old fire-once code also consumed
  // the request immediately (+ dedup ref), so it never retried once the scroller
  // was ready → the viewport stayed at the top. Fix: claim the request, then
  // scroll only AFTER paint and once the scroller has a real height, recomputing
  // the index against the latest rows. (See useChatSearch for the same async/
  // retry treatment of Virtuoso navigation.)
  useEffect(() => {
    if (!revealRequest || lastRevealRequestIdRef.current === revealRequest.id) {
      return;
    }
    // Ancestors may still be (lazily) expanding — bail until the row exists; the
    // next `rows` change re-runs this effect.
    if (rows.findIndex((row) => row.path === revealRequest.path) < 0) {
      return;
    }
    const { id, path } = revealRequest;
    lastRevealRequestIdRef.current = id;
    revealCancelRef.current?.(); // supersede any prior pending reveal

    let framesLeft = REVEAL_READINESS_MAX_FRAMES;
    let rafHandle = 0;
    const attempt = () => {
      const el = scrollerElRef.current;
      const index = rowsRef.current.findIndex((row) => row.path === path);
      if (index >= 0 && el && el.clientHeight > 0) {
        // Instant (not 'smooth'): robust to a list refresh interrupting the
        // animation, and the right UX for a "jump to file" reveal.
        virtuosoRef.current?.scrollToIndex({ index, align: "center", behavior: "auto" });
        onRevealHandled?.(id);
        revealCancelRef.current = null;
        return;
      }
      if (framesLeft-- <= 0) {
        onRevealHandled?.(id);
        revealCancelRef.current = null;
        return;
      }
      rafHandle = requestAnimationFrame(attempt);
    };
    const cancelFirst = runAfterNextPaint(attempt);
    revealCancelRef.current = () => {
      cancelFirst();
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };
    // No cleanup-cancel: this effect re-runs on every `rows` change (lazy expand /
    // refresh) and cancelling would abort an in-flight reveal. Same-id re-runs bail
    // at the top; unmount cancellation is the dedicated effect above.
  }, [onRevealHandled, revealRequest, rows]);

  return (
    <>
      <WorkspaceTreeStickyAncestors
        ancestors={stickyAncestors}
        rowHeight={rowHeight}
        onClosePath={onCloseAncestorPath}
      />
      <Virtuoso
        ref={virtuosoRef}
        className="h-full overscroll-none"
        components={TREE_COMPONENTS}
        computeItemKey={(_index, row) => row.path}
        context={context}
        data={rows}
        fixedItemHeight={rowHeight}
        increaseViewportBy={{ bottom: rowHeight * 8, top: rowHeight * 4 }}
        scrollerRef={handleScrollerRef}
        itemContent={(_index, row) => (
          <WorkspaceTreeRow
            row={row}
            rowHeight={rowHeight}
            isDropTarget={row.isDir && dropTargetPath === row.path}
            isInternalDropTarget={row.isDir && internalDropTarget === row.path}
            isDragging={activeDragPaths.includes(row.path)}
            onClick={(event) => onRowClick(row, event)}
            onContextMenu={(event) => onRowContextMenu(row, event)}
            onDragEnter={(event) => onRowDragEnter(event, row)}
            onDragLeave={(event) => onRowDragLeave(event, row)}
          />
        )}
      />
    </>
  );
});
