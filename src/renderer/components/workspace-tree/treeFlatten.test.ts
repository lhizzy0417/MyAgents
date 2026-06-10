import { describe, expect, it, vi } from "vitest";

import type { StickyAncestor } from "./treeTypes";

import type { DirectoryTreeNode } from "../../../shared/dir-types";
import type { VisibleTreeRow, WorkspaceTreeNodeMeta } from "./treeTypes";

import {
  buildStickyAncestors,
  MAX_STICKY_ANCESTOR_DEPTH,
  resolveStickyAncestors,
} from "./treeFlatten";

const ROW = 26;

/**
 * Build an `ancestorsAt(firstVisibleIndex)` stub that mirrors the real
 * `getStickyAncestors`: index 0 (or below) has no ancestors, otherwise the
 * ancestor count for that index comes from `depthByIndex`, capped at maxDepth.
 */
function ancestorsAtFrom(
  depthByIndex: Record<number, number>,
  maxDepth = MAX_STICKY_ANCESTOR_DEPTH,
): (firstVisibleIndex: number) => StickyAncestor[] {
  return (firstVisibleIndex: number) => {
    if (firstVisibleIndex <= 0) return [];
    const count = Math.min(depthByIndex[firstVisibleIndex] ?? 0, maxDepth);
    return Array.from({ length: count }, (_, i) => ({
      depth: i,
      id: `anc-${firstVisibleIndex}-${i}`,
      name: `anc-${firstVisibleIndex}-${i}`,
      path: `/anc/${firstVisibleIndex}/${i}`,
    }));
  };
}

// OVERLAY MODEL (regression for the "sticky jump" bug): the breadcrumb bar
// floats OVER the scroll content and occupies no scroll space, so data rows
// never shift when the breadcrumb depth changes. The row at the sticky bar's
// bottom edge is therefore `floor(scrollTop / rowHeight) + count` — count
// enters POSITIVELY (the bar covers `count` rows below the viewport top).
// The pre-fix header-spacer model used `topUnits - count`, which required a
// scroll-content spacer whose height change made the whole list jump by
// ±rowHeight at every depth boundary while scrolling.
describe("resolveStickyAncestors", () => {
  it("returns [] at the very top (scrollTop <= 0)", () => {
    const spy = vi.fn(() => [] as StickyAncestor[]);
    expect(resolveStickyAncestors(0, ROW, MAX_STICKY_ANCESTOR_DEPTH, spy)).toEqual([]);
    expect(resolveStickyAncestors(-5, ROW, MAX_STICKY_ANCESTOR_DEPTH, spy)).toEqual([]);
    // No need to probe ancestors when there is no scroll.
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] for a non-positive rowHeight (guard against div-by-zero)", () => {
    const spy = vi.fn(() => [] as StickyAncestor[]);
    expect(resolveStickyAncestors(100, 0, MAX_STICKY_ANCESTOR_DEPTH, spy)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns [] when the boundary row is a top-level entry (no ancestors)", () => {
    // scrollTop two rows down; row 2 has depth 0 → empty stack is consistent.
    const ancestorsAt = ancestorsAtFrom({ 2: 0 });
    expect(
      resolveStickyAncestors(2 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt),
    ).toEqual([]);
  });

  it("returns [] just past the top while the index is still 0", () => {
    // scrollTop within the first row → topUnits = 0, count starts 0 →
    // firstVisibleIndex 0 → guard yields [] → consistent.
    const ancestorsAt = ancestorsAtFrom({ 1: 2 });
    expect(
      resolveStickyAncestors(10, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt),
    ).toEqual([]);
  });

  it("probes the row BELOW the bar (topUnits + count), never an already-scrolled-out row", () => {
    // topUnits = 4. With a 2-deep stack the bar covers rows 4..5, so the
    // consistent boundary row is 6 — NOT row 2 (the header-spacer model's
    // `topUnits - count`).
    const ancestorsAt = vi.fn(ancestorsAtFrom({ 4: 2, 6: 2 }));
    const result = resolveStickyAncestors(
      4 * ROW,
      ROW,
      MAX_STICKY_ANCESTOR_DEPTH,
      ancestorsAt,
    );
    expect(result).toHaveLength(2);
    const probedIndexes = ancestorsAt.mock.calls.map((c) => c[0]);
    expect(probedIndexes).toContain(6);
    expect(probedIndexes.every((i) => i >= 4)).toBe(true);
  });

  it("resolves a multi-step fixed point (depth grows as the bar covers more rows)", () => {
    // topUnits = 5. count 0→idx5(=1)→count1→idx6(=3)→count3→idx8(=3) → settle 3.
    const ancestorsAt = ancestorsAtFrom({ 5: 1, 6: 3, 8: 3 });
    const result = resolveStickyAncestors(
      5 * ROW,
      ROW,
      MAX_STICKY_ANCESTOR_DEPTH,
      ancestorsAt,
    );
    expect(result).toHaveLength(3);
  });

  it("caps the stack at maxDepth", () => {
    const ancestorsAt = ancestorsAtFrom({ 10: 9, 13: 9 }, 3);
    const result = resolveStickyAncestors(10 * ROW, ROW, 3, ancestorsAt);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic at a depth boundary with no exact fixed point (no oscillation)", () => {
    // f alternates between adjacent candidate rows, so there is no exact
    // fixed point. The result must still be identical across calls — that
    // determinism is what kills the cross-render flicker.
    const ancestorsAt = ancestorsAtFrom({ 3: 1, 4: 0 });
    const a = resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt);
    const b = resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt);
    const c = resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt);
    expect(a.map((x) => x.path)).toEqual(b.map((x) => x.path));
    expect(b.map((x) => x.path)).toEqual(c.map((x) => x.path));
  });

  it("never calls the walker more than maxDepth + 1 times (bounded work)", () => {
    const base = ancestorsAtFrom({ 3: 1, 4: 0 });
    const spy = vi.fn(base);
    resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, spy);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(MAX_STICKY_ANCESTOR_DEPTH + 1);
  });
});

describe("buildStickyAncestors probe clamping", () => {
  function makeRows(): {
    rows: VisibleTreeRow[];
    meta: Map<string, WorkspaceTreeNodeMeta>;
  } {
    const dir: DirectoryTreeNode = { id: "a", name: "a", path: "a", type: "dir" };
    const child = (p: string): DirectoryTreeNode => ({
      id: p,
      name: p.split("/").pop() ?? p,
      path: p,
      type: "file",
    });
    const rows: VisibleTreeRow[] = [
      {
        data: dir,
        depth: 0,
        isDir: true,
        isLoading: false,
        isOpen: true,
        isSelected: false,
        parentPath: null,
        path: "a",
      },
      ...["a/x.md", "a/y.md"].map((p) => ({
        data: child(p),
        depth: 1,
        isDir: false,
        isLoading: false,
        isOpen: false,
        isSelected: false,
        parentPath: "a",
        path: p,
      })),
    ];
    const meta = new Map<string, WorkspaceTreeNodeMeta>([
      ["a", { data: dir, depth: 0, parentPath: null }],
    ]);
    return { rows, meta };
  }

  // Regression: the overlay probe (`topUnits + count`) can overshoot the row
  // list near the scroll bottom of a SHORT viewport. Bailing to [] there made
  // the fixed point oscillate between [] and an n-deep stack across row
  // boundaries (per-row breadcrumb flicker at the bottom). Overshoot must
  // clamp to the LAST row's ancestors instead.
  it("clamps an overshooting index to the last row's ancestors", () => {
    const { rows, meta } = makeRows();
    const result = buildStickyAncestors(rows, meta, 10, ROW, MAX_STICKY_ANCESTOR_DEPTH);
    expect(result.map((a) => a.path)).toEqual(["a"]);
  });

  it("still returns [] for an empty row list", () => {
    expect(
      buildStickyAncestors([], new Map(), 5, ROW, MAX_STICKY_ANCESTOR_DEPTH),
    ).toEqual([]);
  });
});
