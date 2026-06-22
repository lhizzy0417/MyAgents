import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDirectorySearch } from './useDirectorySearch';

const searchMocks = vi.hoisted(() => ({
  searchWorkspaceFiles: vi.fn(),
  refreshWorkspaceFileIndex: vi.fn(),
}));

vi.mock('@/api/searchClient', () => ({
  searchWorkspaceFiles: searchMocks.searchWorkspaceFiles,
  refreshWorkspaceFileIndex: searchMocks.refreshWorkspaceFileIndex,
}));

function SearchHarness() {
  const search = useDirectorySearch('/workspace');

  return (
    <div>
      <button onClick={() => search.setIsSearchMode(true)}>open</button>
      <button onClick={() => search.setIsSearchMode(false)}>close</button>
      <input
        aria-label="query"
        value={search.searchQuery}
        onChange={(event) => search.setSearchQuery(event.target.value)}
      />
      <output aria-label="loading">{String(search.isSearching)}</output>
      <output aria-label="refreshing">{String(search.isRefreshingSearch)}</output>
      <output aria-label="hits">{search.searchResults.map((hit) => hit.path).join(',')}</output>
      <output aria-label="expanded">{Array.from(search.expandedFiles).join(',')}</output>
    </div>
  );
}

describe('useDirectorySearch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    searchMocks.searchWorkspaceFiles.mockReset();
    searchMocks.refreshWorkspaceFileIndex.mockReset();
    searchMocks.searchWorkspaceFiles
      .mockResolvedValueOnce({
        hits: [{ path: 'docs/old.md', matches: [{ lineNumber: 3, text: 'old' }] }],
      })
      .mockResolvedValueOnce({
        hits: [{ path: 'docs/new.md', matches: [{ lineNumber: 4, text: 'new' }] }],
      });
    searchMocks.refreshWorkspaceFileIndex.mockResolvedValue([0, 1]);
  });

  it('searches after debounce and refreshes stale results when the index changes', async () => {
    render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'note' } });

    await waitFor(() => expect(screen.getByLabelText('hits')).toHaveTextContent('docs/old.md'));
    expect(screen.getByLabelText('expanded')).toHaveTextContent('docs/old.md');
    expect(searchMocks.searchWorkspaceFiles).toHaveBeenCalledWith('note', '/workspace');

    await waitFor(() => expect(screen.getByLabelText('hits')).toHaveTextContent('docs/new.md'));
    expect(searchMocks.refreshWorkspaceFileIndex).toHaveBeenCalledWith('/workspace');
    expect(searchMocks.searchWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it('cancels the pending refresh delay when unmounted', async () => {
    vi.useFakeTimers();
    searchMocks.searchWorkspaceFiles.mockReset().mockResolvedValue({
      hits: [{ path: 'docs/old.md', matches: [{ lineNumber: 3, text: 'old' }] }],
    });
    const { unmount } = render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'note' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByLabelText('hits')).toHaveTextContent('docs/old.md');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(searchMocks.refreshWorkspaceFileIndex).not.toHaveBeenCalled();
  });
});
