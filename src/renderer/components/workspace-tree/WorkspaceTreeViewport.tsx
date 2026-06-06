import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import type { Components, ContextProp, ListRange } from "react-virtuoso";
import type { VirtuosoHandle } from "react-virtuoso";

import { WorkspaceTreeRow } from "./WorkspaceTreeRow";
import { WorkspaceTreeStickyAncestors } from "./WorkspaceTreeStickyAncestors";
import type { StickyAncestor, VisibleTreeRow } from "./treeTypes";

interface ViewportContext {
  stickyHeight: number;
}

const TreeHeaderSpacer = memo(function TreeHeaderSpacer({
  context,
}: ContextProp<ViewportContext>) {
  if (context.stickyHeight <= 0) {
    return null;
  }
  return <div aria-hidden="true" style={{ height: context.stickyHeight }} />;
});

const TREE_COMPONENTS: Components<VisibleTreeRow, ViewportContext> = {
  Header: TreeHeaderSpacer,
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
  const [firstVisibleIndex, setFirstVisibleIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(
    null,
  );
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const lastRevealRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (!scrollerElement) {
      return;
    }
    if (initialScrollTop > 0) {
      scrollerElement.scrollTo({ top: initialScrollTop });
    }
  }, [initialScrollTop, scrollerElement]);

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

  const stickyAncestors = useMemo(
    () => getStickyAncestors(firstVisibleIndex, scrollTop),
    [firstVisibleIndex, getStickyAncestors, scrollTop],
  );
  const context = useMemo<ViewportContext>(
    () => ({ stickyHeight: stickyAncestors.length * rowHeight }),
    [rowHeight, stickyAncestors.length],
  );

  const handleRangeChanged = useCallback((range: ListRange) => {
    setFirstVisibleIndex(range.startIndex);
  }, []);
  const handleScrollerRef = useCallback((element: HTMLElement | null | Window) => {
    setScrollerElement(element instanceof HTMLElement ? element : null);
  }, []);

  useEffect(() => {
    if (!revealRequest || lastRevealRequestIdRef.current === revealRequest.id) {
      return;
    }
    const index = rows.findIndex((row) => row.path === revealRequest.path);
    if (index < 0) {
      return;
    }
    lastRevealRequestIdRef.current = revealRequest.id;
    virtuosoRef.current?.scrollToIndex({
      index,
      align: "center",
      behavior: "smooth",
    });
    onRevealHandled?.(revealRequest.id);
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
        rangeChanged={handleRangeChanged}
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
