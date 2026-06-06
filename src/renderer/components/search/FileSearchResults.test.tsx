import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { FileSearchHit } from '@/api/searchClient';
import FileSearchResults from './FileSearchResults';

const hit: FileSearchHit = {
    path: 'docs/note.md',
    name: 'note.md',
    matchCount: 2,
    matches: [
        {
            lineNumber: 12,
            lineContent: '  high school exam note',
            highlights: [[2, 6]],
        },
        {
            lineNumber: 24,
            lineContent: 'second match',
            highlights: [[0, 6]],
        },
    ],
};

function renderResults(overrides: Partial<ComponentProps<typeof FileSearchResults>> = {}) {
    const props: ComponentProps<typeof FileSearchResults> = {
        results: [hit],
        isLoading: false,
        isRefreshing: false,
        query: 'high',
        expandedFiles: new Set([hit.path]),
        activeTarget: null,
        onToggleFile: vi.fn(),
        onFileClick: vi.fn(),
        onRevealInTree: vi.fn(),
        onMatchClick: vi.fn(),
        onContextMenu: vi.fn(),
        ...overrides,
    };
    render(<FileSearchResults {...props} />);
    return props;
}

describe('FileSearchResults', () => {
    it('keeps expand/collapse separate from file preview', () => {
        const props = renderResults();

        fireEvent.click(screen.getByRole('button', { name: '折叠结果' }));
        expect(props.onToggleFile).toHaveBeenCalledWith(hit.path);
        expect(props.onFileClick).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /note\.md/ }));
        expect(props.onFileClick).toHaveBeenCalledWith(hit);
    });

    it('exposes reveal-in-tree as an icon-only action', () => {
        const props = renderResults();

        fireEvent.click(screen.getByTitle('在文件目录中展示'));

        expect(props.onRevealInTree).toHaveBeenCalledWith(hit);
        expect(props.onFileClick).not.toHaveBeenCalled();
    });

    it('passes the full search hit to match clicks and context menus', () => {
        const props = renderResults();

        const matchRow = screen.getByText('high').closest('[role="button"]');
        expect(matchRow).not.toBeNull();
        fireEvent.click(matchRow!);
        expect(props.onMatchClick).toHaveBeenCalledWith(hit, hit.matches[0]);

        fireEvent.contextMenu(screen.getByTitle(hit.path));
        expect(props.onContextMenu).toHaveBeenCalledWith(expect.anything(), hit);
    });
});
