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

  // Clamp to the last row instead of bailing: the overlay-model probe
  // (`topUnits + count`) can overshoot the row list near the scroll bottom
  // when the viewport is only a few rows tall. Bailing to `[]` there makes
  // the fixed-point iteration oscillate between `[]` and an n-deep stack at
  // every row boundary (visible as per-row breadcrumb flicker); clamping
  // means "use the last row's ancestors" — which is also the correct VS Code
  // semantics for a bottom-pinned view.
  const row = visibleRows[Math.min(firstVisibleIndex, visibleRows.length - 1)];
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
 * CONSTANT `MAX_STICKY_ANCESTOR_DEPTH * rowHeight` footer at the scroll bottom
 * so `maxScroll` never moves (the breadcrumb stays flicker-free at the bottom)
 * AND the last rows can scroll clear of the overlay bar — see
 * `resolveStickyAncestors` and `WorkspaceTreeViewport`. The model's
 * `buildStickyAncestors` cap MUST use the same value.
 */
export const MAX_STICKY_ANCESTOR_DEPTH = 3;

/**
 * Resolve the sticky breadcrumb as a PURE FUNCTION of `scrollTop`,
 * OVERLAY model (VS Code sticky-scroll semantics).
 *
 * The breadcrumb bar floats OVER the scroll content and occupies no scroll
 * space. This is load-bearing for two scroll-stability properties:
 *
 *  1. No content jump at depth boundaries. The previous header-spacer model
 *     inserted a `count * rowHeight` spacer into the scroll content so the
 *     bar never covered a row — but every time `count` changed mid-scroll the
 *     spacer resized and the WHOLE list visually jumped by ±rowHeight (the
 *     "sticky跳动" bug). With an overlay nothing in the scroll content ever
 *     resizes, so rows never shift; the bar simply covers the top `count`
 *     rows, exactly like VS Code.
 *
 *  2. No scroll↔layout feedback loop at the bottom. The scroll content height
 *     is constant (rows + constant footer), so `maxScroll` never moves and
 *     `scrollTop` is a stable input.
 *
 * Derivation: with the bar covering `count` rows, the row at the bar's bottom
 * edge is `floor(scrollTop / rowHeight) + count`. That's circular in `count`,
 * but `count` is bounded by `maxDepth`, so we resolve it by fixed-point
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
    const firstVisibleIndex = topUnits + count;
    ancestors = ancestorsAt(firstVisibleIndex);
    if (ancestors.length === count) {
      return ancestors;
    }
    count = ancestors.length;
  }
  return ancestors;
}
