import { describe, expect, it, vi } from "vitest";

import type { StickyAncestor } from "./treeTypes";

import {
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

  it("returns [] when the top row is a top-level entry (no ancestors)", () => {
    // scrollTop two rows down; row 2 has depth 0.
    const ancestorsAt = ancestorsAtFrom({ 2: 0 });
    expect(
      resolveStickyAncestors(2 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt),
    ).toEqual([]);
  });

  it("returns [] just past the top while the header would clamp the index to 0", () => {
    // scrollTop within the first row → topUnits = 0 → firstVisibleIndex clamps
    // to 0 → guard yields [].
    const ancestorsAt = ancestorsAtFrom({ 1: 2 });
    expect(
      resolveStickyAncestors(10, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt),
    ).toEqual([]);
  });

  it("converges to the self-consistent ancestor stack", () => {
    // topUnits = 4. The header pushes content down by count rows, so the first
    // visible row is 4 - count. With a 2-deep stack the consistent row is 2.
    const ancestorsAt = ancestorsAtFrom({ 4: 2, 2: 2 });
    const result = resolveStickyAncestors(
      4 * ROW,
      ROW,
      MAX_STICKY_ANCESTOR_DEPTH,
      ancestorsAt,
    );
    expect(result).toHaveLength(2);
  });

  it("resolves a multi-step fixed point (depth grows as the header offsets the index)", () => {
    // topUnits = 5. count 0→idx5(=3)→count3→idx2(=3) consistent → 3 ancestors.
    const ancestorsAt = ancestorsAtFrom({ 5: 3, 2: 3 });
    const result = resolveStickyAncestors(
      5 * ROW,
      ROW,
      MAX_STICKY_ANCESTOR_DEPTH,
      ancestorsAt,
    );
    expect(result).toHaveLength(3);
  });

  it("caps the stack at maxDepth", () => {
    const ancestorsAt = ancestorsAtFrom({ 10: 9, 7: 9, 8: 9 }, 3);
    const result = resolveStickyAncestors(10 * ROW, ROW, 3, ancestorsAt);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("is deterministic at a depth boundary with no exact fixed point (no oscillation)", () => {
    // f(idx) alternates between adjacent candidate rows, so there is no exact
    // fixed point. The result must still be identical across calls — that
    // determinism is what kills the cross-render flicker.
    const ancestorsAt = ancestorsAtFrom({ 3: 2, 1: 1, 2: 2 });
    const a = resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt);
    const b = resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt);
    const c = resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, ancestorsAt);
    expect(a.map((x) => x.path)).toEqual(b.map((x) => x.path));
    expect(b.map((x) => x.path)).toEqual(c.map((x) => x.path));
  });

  it("never calls the walker more than maxDepth + 1 times (bounded work)", () => {
    const base = ancestorsAtFrom({ 3: 2, 1: 1, 2: 2 });
    const spy = vi.fn(base);
    resolveStickyAncestors(3 * ROW, ROW, MAX_STICKY_ANCESTOR_DEPTH, spy);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(MAX_STICKY_ANCESTOR_DEPTH + 1);
  });
});
