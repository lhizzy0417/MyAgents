import { render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { DirectoryTreeNode } from '../../../shared/dir-types';
import type { VisibleTreeRow } from './treeTypes';
import { WorkspaceTreeViewport } from './WorkspaceTreeViewport';

const mocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
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

describe('WorkspaceTreeViewport reveal request', () => {
  it('scrolls to the requested row and marks the request consumed', async () => {
    const onRevealHandled = vi.fn();

    render(
      <WorkspaceTreeViewport
        rows={[fileRow('a.md'), fileRow('dir/b.md')]}
        rowHeight={26}
        dropTargetPath={null}
        internalDropTarget={null}
        activeDragPaths={[]}
        revealRequest={{ id: 7, path: 'dir/b.md' }}
        onRevealHandled={onRevealHandled}
        getStickyAncestors={() => []}
        onCloseAncestorPath={vi.fn()}
        onRowClick={vi.fn()}
        onRowContextMenu={vi.fn()}
        onRowDragEnter={vi.fn()}
        onRowDragLeave={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(mocks.scrollToIndex).toHaveBeenCalledWith({
        index: 1,
        align: 'center',
        behavior: 'smooth',
      });
    });
    expect(onRevealHandled).toHaveBeenCalledWith(7);
  });
});
