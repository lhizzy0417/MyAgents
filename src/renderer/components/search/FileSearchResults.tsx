/**
 * FileSearchResults - Renders workspace file search results in a grouped list format.
 * Emulates the VS Code search results pane.
 */

import { memo } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import type { FileSearchHit } from '@/api/searchClient';
import SearchHighlight from './SearchHighlight';
import { getFileIcon } from '@/utils/fileIcons';

interface FileSearchResultsProps {
    results: FileSearchHit[];
    isLoading: boolean;
    isRefreshing: boolean;
    query: string;
    expandedFiles: Set<string>;
    onToggleFile: (path: string) => void;
    onFileClick: (path: string) => void;
    onMatchClick: (path: string, lineNumber: number) => void;
    onContextMenu: (e: React.MouseEvent, path: string) => void;
}

export default memo(function FileSearchResults({
    results,
    isLoading,
    isRefreshing,
    query,
    expandedFiles,
    onToggleFile,
    onFileClick: _onFileClick,
    onMatchClick,
    onContextMenu,
}: FileSearchResultsProps) {
    if (isLoading && results.length === 0) {
        return (
            <div className="flex h-full flex-col px-4 py-3 pb-8 overflow-y-auto overscroll-contain">
                <div className="flex items-center gap-2 mb-4">
                    <div className="text-[11px] font-medium text-[var(--ink-muted)]">搜索中...</div>
                </div>
            </div>
        );
    }

    if (!query) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center text-[13px] text-[var(--ink-muted)]/60">
                <p>在当前工作区中搜索</p>
                <p className="mt-1 text-[11px]">文件名和文件内容</p>
            </div>
        );
    }

    if (results.length === 0) {
        return (
            <div className="flex h-full flex-col px-4 py-3 pb-8 overflow-y-auto overscroll-contain">
                <div className="flex items-center gap-2 mb-4">
                    <div className="text-[11px] font-medium text-[var(--ink-muted)]">
                        0 个结果{isRefreshing ? ' · 正在更新索引...' : ''}
                    </div>
                </div>
            </div>
        );
    }

    const totalMatches = results.reduce((acc, curr) => acc + curr.matchCount, 0);

    return (
        <div className="flex h-full flex-col pb-8 overflow-y-auto overscroll-contain" style={{ scrollbarGutter: 'stable' }}>
            <div className="sticky top-0 z-10 bg-[var(--paper)]/90 px-4 py-2 backdrop-blur-sm border-b border-[var(--line-subtle)]">
                <div className="text-[11px] font-medium text-[var(--ink-muted)]">
                    {results.length} 个文件中找到 {totalMatches} 个结果{isRefreshing ? ' · 正在更新索引...' : ''}
                </div>
            </div>

            <div className="py-2">
                {results.map((hit) => {
                    const isExpanded = expandedFiles.has(hit.path);
                    const FileIcon = getFileIcon(hit.name);

                    // Separate path into dirname and basename for display
                    const pathParts = hit.path.split('/');
                    const basename = pathParts.pop() || hit.path;
                    const dirname = pathParts.join('/');

                    return (
                        <div key={hit.path} className="flex flex-col">
                            {/* File Header Row */}
                            <div
                                role="button"
                                title={hit.path}
                                className="group flex h-7 items-center pr-3 pl-2 text-[13px] hover:bg-[var(--hover-bg)] cursor-pointer select-none"
                                onClick={() => onToggleFile(hit.path)}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onContextMenu(e, hit.path);
                                }}
                            >
                                <div className="flex w-5 shrink-0 items-center justify-center text-[var(--ink-muted)]">
                                    {isExpanded ? (
                                        <ChevronDown className="h-4 w-4" />
                                    ) : (
                                        <ChevronRight className="h-4 w-4" />
                                    )}
                                </div>
                                <div className="flex h-full items-center gap-1.5 flex-1 min-w-0 pr-2">
                                    <FileIcon className="h-3.5 w-3.5 shrink-0" />
                                    {/* Basename — never shrinks, full name always visible */}
                                    <span className="shrink-0 text-[var(--ink)]">
                                        <SearchHighlight
                                            text={basename}
                                            highlights={hit.name.toLowerCase().includes(query.toLowerCase())
                                                ? [[0, basename.length]] // Very simplified file name highlighting for now
                                                : []}
                                        />
                                    </span>
                                    {/* Dirname — takes remaining space, truncates with ellipsis */}
                                    {dirname && (
                                        <span className="min-w-0 truncate text-[11px] text-[var(--ink-muted)]/70 ml-1">
                                            {dirname}
                                        </span>
                                    )}
                                </div>
                                <div className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-[var(--paper-inset)] text-[10px] text-[var(--ink-muted)] font-medium">
                                    {hit.matchCount}
                                </div>
                            </div>

                            {/* Match Lines */}
                            {isExpanded && hit.matches.length > 0 && (
                                <div className="flex flex-col">
                                    {hit.matches.map((match, idx) => (
                                        <div
                                            key={`${hit.path}-${match.lineNumber}-${idx}`}
                                            role="button"
                                            className="group flex min-h-6 items-start py-0.5 pr-3 pl-[30px] text-[12px] hover:bg-[var(--hover-bg)] hover:text-[var(--ink)] cursor-pointer text-[var(--ink-secondary)] transition-colors"
                                            onClick={() => onMatchClick(hit.path, match.lineNumber)}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onContextMenu(e, hit.path);
                                            }}
                                        >
                                            {/* Line number */}
                                            <div className="w-8 shrink-0 text-right text-[10px] text-[var(--ink-muted)]/60 font-mono pt-[1px] select-none pr-3">
                                                {match.lineNumber}
                                            </div>
                                            {/* Line content */}
                                            <div className="flex-1 min-w-0 break-words whitespace-pre-wrap font-mono leading-relaxed group-hover:text-[var(--ink)]">
                                                <SearchHighlight
                                                    text={match.lineContent.trimStart()}
                                                    highlights={adjustHighlightsForTrim(match.lineContent, match.highlights)}
                                                />
                                            </div>
                                        </div>
                                    ))}
                                    {hit.matchCount > hit.matches.length && (
                                        <div className="pl-[38px] py-1 text-[11px] text-[var(--ink-muted)]/50 italic mb-1">
                                            ... 还有 {hit.matchCount - hit.matches.length} 个结果
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
});

/**
 * Adjust highlight indices to account for trimStart() 
 * which removes leading whitespace from the display string.
 */
function adjustHighlightsForTrim(original: string, highlights: [number, number][]): [number, number][] {
    const trimmed = original.trimStart();
    const trimOffset = original.length - trimmed.length;
    
    if (trimOffset === 0) return highlights;

    return highlights.map(([start, end]) => [
        Math.max(0, start - trimOffset),
        Math.max(0, end - trimOffset)
    ]);
}
