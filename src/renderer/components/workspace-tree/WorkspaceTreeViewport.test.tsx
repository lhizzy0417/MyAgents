import { render, waitFor } from '@testing-library/react';
import type { ComponentProps, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DirectoryTreeNode } from '../../../shared/dir-types';
import type { VisibleTreeRow } from './treeTypes';
import { WorkspaceTreeViewport } from './WorkspaceTreeViewport';

const mocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  // jsdom has no layout — drive the readiness gate (scroller clientHeight > 0)
  // explicitly. >0 = laid out (reveal scrolls); 0 = unmeasured (reveal must NOT
  // scroll into a 0-height viewport, but still releases the request).
  scrollerHeight: 200,
}));

vi.mock('react-virtuoso', async () => {
  const React = await import('react');
  return {
    Virtuoso: React.forwardRef(function MockVirtuoso(
      props: {
        data: VisibleTreeRow[];
        itemContent: (index: number, row: VisibleTreeRow) => ReactNode;
        scrollerRef?: (element: HTMLElement | null) => void;
      },
      ref,
    ) {
      const { data, itemContent, scrollerRef } = props;
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: mocks.scrollToIndex,
      }));
      React.useEffect(() => {
        const element = document.createElement('div');
        Object.defineProperty(element, 'clientHeight', {
          configurable: true,
          get: () => mocks.scrollerHeight,
        });
        scrollerRef?.(element);
        return () => scrollerRef?.(null);
      }, [scrollerRef]);

      return (
        <div>
          {data.map((row, index) => (
            <div key={row.path}>{itemContent(index, row)}</div>
          ))}
        </div>
      );
    }),
  };
});

vi.mock('./WorkspaceTreeRow', () => ({
  WorkspaceTreeRow: ({ row }: { row: VisibleTreeRow }) => (
    <div data-testid={`row-${row.path}`}>{row.path}</div>
  ),
}));

vi.mock('./WorkspaceTreeStickyAncestors', () => ({
  WorkspaceTreeStickyAncestors: () => null,
}));

function fileRow(path: string): VisibleTreeRow {
  const name = path.split('/').pop() ?? path;
  const data: DirectoryTreeNode = {
    id: path,
    name,
    path,
    type: 'file',
  };
  return {
    data,
    depth: path.includes('/') ? 1 : 0,
    isDir: false,
    isLoading: false,
    isOpen: false,
    isSelected: false,
    parentPath: null,
    path,
  };
}

function fileItems(paths: string[]) {
  return paths.map((p) => {
    const row = fileRow(p);
    return { kind: 'node' as const, key: row.path, row };
  });
}

function renderViewport(overrides: Partial<ComponentProps<typeof WorkspaceTreeViewport>> = {}) {
  const onRevealHandled = vi.fn();
  render(
    <WorkspaceTreeViewport
      items={fileItems(['a.md', 'dir/b.md'])}
      rowHeight={26}
      dropTargetPath={null}
      internalDropTarget={null}
      activeDragPaths={[]}
      cutPaths={[]}
      focusedPath={null}
      treeActive={false}
      revealRequest={{ id: 7, path: 'dir/b.md' }}
      onRevealHandled={onRevealHandled}
      getStickyAncestors={() => []}
      onCloseAncestorPath={vi.fn()}
      onJumpToAncestorPath={vi.fn()}
      onAncestorContextMenu={vi.fn()}
      onRowClick={vi.fn()}
      onRowContextMenu={vi.fn()}
      onEditCommit={vi.fn()}
      onEditCancel={vi.fn()}
      {...overrides}
    />,
  );
  return onRevealHandled;
}

describe('WorkspaceTreeViewport reveal request', () => {
  beforeEach(() => {
    mocks.scrollToIndex.mockClear();
    mocks.scrollerHeight = 200;
  });

  // Regression (the reported bug): the tree is conditionally rendered, so a reveal
  // hits a fresh-mounted Virtuoso whose scroller isn't measured yet. The old code
  // fired scrollToIndex synchronously on mount (no-op) and consumed the request
  // immediately, so the viewport stayed at the top. The reveal must be deferred
  // until the scroller is laid out, then actually scroll.
  it('defers and scrolls to the requested row once the scroller is laid out', async () => {
    const onRevealHandled = renderViewport();

    await waitFor(() => {
      expect(mocks.scrollToIndex).toHaveBeenCalledWith({
        index: 1,
        align: 'center',
        behavior: 'auto',
      });
    });
    expect(onRevealHandled).toHaveBeenCalledWith(7);
  });

  // The readiness gate: a 0-height (unmeasured/hidden) scroller can't be scrolled,
  // so the reveal must NOT issue scrollToIndex — but it must still release the
  // request so it doesn't wedge.
  it('does not scroll into a 0-height viewport but still releases the request', async () => {
    mocks.scrollerHeight = 0;
    const onRevealHandled = renderViewport();

    await waitFor(() => {
      expect(onRevealHandled).toHaveBeenCalledWith(7);
    });
    expect(mocks.scrollToIndex).not.toHaveBeenCalled();
  });
});
