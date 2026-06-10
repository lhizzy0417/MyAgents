import { ChevronRight, Folder, FolderOpen, Loader2 } from "lucide-react";
import { memo, useCallback } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";

import { getFileIconElement } from "@/utils/fileIcons";

import type { VisibleTreeRow } from "./treeTypes";

interface WorkspaceTreeRowProps {
  row: VisibleTreeRow;
  rowHeight: number;
  isDropTarget: boolean;
  isInternalDropTarget: boolean;
  isDragging: boolean;
  onClick: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const WorkspaceTreeRow = memo(function WorkspaceTreeRow({
  row,
  rowHeight,
  isDropTarget,
  isInternalDropTarget,
  isDragging,
  onClick,
  onContextMenu,
}: WorkspaceTreeRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
  } = useDraggable({
    id: `drag:${row.path}`,
    data: row.data,
  });
  // Every row is droppable — FILE rows resolve to their parent directory in
  // the panel's drop-target resolver (VS Code semantics). Pre-fix file rows
  // were disabled, so dragging over them yielded `over=null`, which the panel
  // interpreted as "workspace root" → items silently moved to the root.
  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop:${row.path}`,
  });

  const mergedRef = useCallback(
    (element: HTMLDivElement | null) => {
      setDragRef(element);
      setDropRef(element);
    },
    [setDragRef, setDropRef],
  );

  // Single highlight source: the panel-resolved target (state). The raw
  // dnd-kit `isOver` is deliberately NOT used — it disagrees with the resolved
  // target for file rows (parent dir) and lags one frame behind, which read
  // as highlight flicker while dragging.
  const highlight = isDropTarget || isInternalDropTarget;

  return (
    <div
      ref={mergedRef}
      data-tree-row
      data-tree-path={row.path}
      {...attributes}
      {...listeners}
      className={`flex cursor-pointer items-center gap-2 px-3 text-[13px] transition-colors select-none ${
        highlight
          ? "ring-1 ring-inset ring-[var(--accent)]/40 bg-[var(--accent)]/8"
          : isDragging
            ? "opacity-40"
            : row.isSelected
              ? "bg-[var(--paper-inset)] text-[var(--ink)]"
              : "text-[var(--ink-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)]"
      }`}
      style={{
        height: rowHeight,
        paddingLeft: `${12 + row.depth * 16}px`,
      }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[var(--ink-muted)]">
        {row.isLoading ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : row.isDir ? (
          <ChevronRight
            className={`h-3 w-3 transition-transform ${row.isOpen ? "rotate-90" : ""}`}
          />
        ) : null}
      </span>
      {row.isDir ? (
        row.isOpen ? (
          <FolderOpen className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]/70" />
        ) : (
          <Folder className="h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]/70" />
        )
      ) : (
        getFileIconElement(row.data.name, {
          className: "h-3.5 w-3.5 flex-shrink-0 text-[var(--accent-warm)]",
        })
      )}
      <span className="min-w-0 flex-1 truncate font-medium">
        {row.data.name}
      </span>
    </div>
  );
});
