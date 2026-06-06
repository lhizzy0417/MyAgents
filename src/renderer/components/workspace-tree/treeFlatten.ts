import type { DirectoryTreeNode } from "../../../shared/dir-types";

import type {
  StickyAncestor,
  VisibleTreeRow,
  WorkspaceTreeNodeMeta,
} from "./treeTypes";

export function buildWorkspaceNodeMetaByPath(
  nodes: DirectoryTreeNode[],
  depth = 0,
  parentPath: string | null = null,
  map = new Map<string, WorkspaceTreeNodeMeta>(),
): Map<string, WorkspaceTreeNodeMeta> {
  for (const node of nodes) {
    map.set(node.path, { data: node, depth, parentPath });
    if (node.type === "dir" && node.children?.length) {
      buildWorkspaceNodeMetaByPath(node.children, depth + 1, node.path, map);
    }
  }
  return map;
}

export function buildVisibleTreeRows(
  nodes: DirectoryTreeNode[],
  openPaths: ReadonlySet<string>,
  loadingPaths: ReadonlySet<string>,
  selectedPaths: ReadonlySet<string>,
  depth = 0,
  parentPath: string | null = null,
  rows: VisibleTreeRow[] = [],
): VisibleTreeRow[] {
  for (const node of nodes) {
    const isDir = node.type === "dir";
    const isOpen = isDir && openPaths.has(node.path);
    rows.push({
      data: node,
      depth,
      isDir,
      isLoading: loadingPaths.has(node.path),
      isOpen,
      isSelected: selectedPaths.has(node.path),
      parentPath,
      path: node.path,
    });
    if (isDir && isOpen && node.children?.length) {
      buildVisibleTreeRows(
        node.children,
        openPaths,
        loadingPaths,
        selectedPaths,
        depth + 1,
        node.path,
        rows,
      );
    }
  }
  return rows;
}

export function buildVisibleRangeSelection(
  visibleRows: VisibleTreeRow[],
  anchorPath: string,
  targetPath: string,
): string[] {
  const startIdx = visibleRows.findIndex((row) => row.path === anchorPath);
  const endIdx = visibleRows.findIndex((row) => row.path === targetPath);
  if (startIdx === -1 || endIdx === -1) {
    return [targetPath];
  }
  const [from, to] =
    startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  return visibleRows.slice(from, to + 1).map((row) => row.path);
}

export function buildStickyAncestors(
  visibleRows: VisibleTreeRow[],
  nodeMetaByPath: ReadonlyMap<string, WorkspaceTreeNodeMeta>,
  firstVisibleIndex: number,
  scrollTop: number,
  maxDepth: number,
): StickyAncestor[] {
  if (scrollTop <= 0 || firstVisibleIndex <= 0) {
    return [];
  }

  const row = visibleRows[firstVisibleIndex];
  if (!row) {
    return [];
  }

  const ancestors: StickyAncestor[] = [];
  let parentPath = row.parentPath;
  while (parentPath && ancestors.length < maxDepth) {
    const meta = nodeMetaByPath.get(parentPath);
    if (!meta) {
      break;
    }
    ancestors.unshift({
      depth: meta.depth,
      id: meta.data.id,
      name: meta.data.name,
      path: parentPath,
    });
    parentPath = meta.parentPath;
  }
  return ancestors;
}

/**
 * Maximum number of stacked sticky-ancestor rows. The viewport reserves a
 * CONSTANT `MAX_STICKY_ANCESTOR_DEPTH * rowHeight` of scroll space at all times
 * (sticky header + complementary footer), which is what makes the breadcrumb
 * flicker-free at the scroll bottom — see `resolveStickyAncestors` and
 * `WorkspaceTreeViewport`. The model's `buildStickyAncestors` cap MUST use the
 * same value so header + footer always sum to this constant.
 */
export const MAX_STICKY_ANCESTOR_DEPTH = 3;

/**
 * Resolve the sticky breadcrumb as a PURE FUNCTION of `scrollTop`.
 *
 * Why not just feed Virtuoso's reported first-visible index back in: the sticky
 * header occupies space at the top of the scroll content, so the index of the
 * first visible data row is itself a function of the header's height — which is
 * a function of how many ancestors we show. Feeding the rendered index back into
 * the ancestor count closes a scroll<->layout loop that only settles where there
 * is free scroll slack; at the very bottom (scroll pinned to max) it oscillates
 * → the "flicker when scrolled to the bottom" bug.
 *
 * The fix is twofold and lives together: (1) the viewport reserves a CONSTANT
 * total height (header + complementary footer = `maxDepth * rowHeight`) so
 * `maxScroll` never moves and `scrollTop` is a stable input; (2) this function
 * derives the breadcrumb from that stable `scrollTop` instead of the rendered
 * index. The header offsets data rows by `count * rowHeight`, so the first
 * visible data row is `floor(scrollTop / rowHeight) - count`. That's circular in
 * `count`, but `count` is bounded by `maxDepth`, so we resolve it by fixed-point
 * iteration in at most `maxDepth + 1` steps. Even at a depth boundary where no
 * exact fixed point exists, the final value is a deterministic function of
 * `scrollTop`, so the result is identical across renders → no oscillation.
 *
 * `ancestorsAt(firstVisibleIndex)` is the per-index ancestor walker (the model's
 * `getStickyAncestors` bound to the current `scrollTop`).
 */
export function resolveStickyAncestors(
  scrollTop: number,
  rowHeight: number,
  maxDepth: number,
  ancestorsAt: (firstVisibleIndex: number) => StickyAncestor[],
): StickyAncestor[] {
  if (scrollTop <= 0 || rowHeight <= 0) {
    return [];
  }
  const topUnits = Math.floor(scrollTop / rowHeight);
  let count = 0;
  let ancestors: StickyAncestor[] = [];
  for (let step = 0; step <= maxDepth; step += 1) {
    const firstVisibleIndex = Math.max(0, topUnits - count);
    ancestors = ancestorsAt(firstVisibleIndex);
    if (ancestors.length === count) {
      return ancestors;
    }
    count = ancestors.length;
  }
  return ancestors;
}
