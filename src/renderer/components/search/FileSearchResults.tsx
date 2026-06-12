/**
 * FileSearchResults - Renders workspace file search results in a grouped list format.
 * Emulates the VS Code search results pane.
 */

import { memo } from 'react';
import { ChevronRight, ChevronDown, LocateFixed } from 'lucide-react';
import type { FileMatchLine, FileSearchHit } from '@/api/searchClient';
import SearchHighlight from './SearchHighlight';
import { getFileIcon } from '@/utils/fileIcons';
import {
    isActiveSearchFile,
    isActiveSearchMatch,
    type ActiveSearchTarget,
} from '@/utils/workspaceSearchNavigation';

interface FileSearchResultsProps {
    results: FileSearchHit[];
    isLoading: boolean;
    isRefreshing: boolean;
    query: string;
    expandedFiles: Set<string>;
    activeTarget: ActiveSearchTarget | null;
    onToggleFile: (path: string) => void;
    onFileClick: (hit: FileSearchHit) => void;
    onRevealInTree: (hit: FileSearchHit) => void;
    onMatchClick: (hit: FileSearchHit, match: FileMatchLine) => void;
    onContextMenu: (e: React.MouseEvent, hit: FileSearchHit) => void;
}

export default memo(function FileSearchResults({
    results,
    isLoading,
    isRefreshing,
    query,
    expandedFiles,
    activeTarget,
    onToggleFile,
    onFileClick,
    onRevealInTree,
    onMatchClick,
    onContextMenu,
}: FileSearchResultsProps) {
    if (isLoading && results.length === 0) {
        return (
            <div className="flex h-full flex-col px-4 py-3 pb-8 overflow-y-auto overscroll-contain">
                <div className="flex items-center gap-2 mb-4">
                    <div className="text-xs font-medium text-[var(--ink-muted)]">搜索中...</div>
                </div>
            </div>
        );
    }

    if (!query) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center text-sm text-[var(--ink-muted)]/60">
                <p>在当前工作区中搜索</p>
                <p className="mt-1 text-xs">文件名和文件内容</p>
            </div>
        );
    }

    if (results.length === 0) {
        return (
            <div className="flex h-full flex-col px-4 py-3 pb-8 overflow-y-auto overscroll-contain">
                <div className="flex items-center gap-2 mb-4">
                    <div className="text-xs font-medium text-[var(--ink-muted)]">
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
                <div className="text-xs font-medium text-[var(--ink-muted)]">
                    {results.length} 个文件中找到 {totalMatches} 个结果{isRefreshing ? ' · 正在更新索引...' : ''}
                </div>
            </div>

            <div className="py-2">
                {results.map((hit) => {
                    const isExpanded = expandedFiles.has(hit.path);
                    const isActiveFile = isActiveSearchFile(activeTarget, hit.path);
                    const FileIcon = getFileIcon(hit.name);

                    // Separate path into dirname and basename for display
                    const pathParts = hit.path.split('/');
                    const basename = pathParts.pop() || hit.path;
                    const dirname = pathParts.join('/');

                    return (
                        <div key={hit.path} className="flex flex-col">
                            {/* File Header Row */}
                            <div
                                role="group"
                                title={hit.path}
                                className={`group flex h-7 items-center pr-3 pl-2 text-sm select-none ${
                                    isActiveFile ? 'bg-[var(--accent-warm-subtle)]' : 'hover:bg-[var(--hover-bg)]'
                                }`}
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    onContextMenu(e, hit);
                                }}
                            >
                                <button
                                    type="button"
                                    className="flex h-full w-5 shrink-0 items-center justify-center text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onToggleFile(hit.path);
                                    }}
                                    aria-label={isExpanded ? '折叠结果' : '展开结果'}
                                >
                                    {isExpanded ? (
                                        <ChevronDown className="h-4 w-4" />
                                    ) : (
                                        <ChevronRight className="h-4 w-4" />
                                    )}
                                </button>
                                <button
                                    type="button"
                                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 pr-2 text-left"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onFileClick(hit);
                                    }}
                                >
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
                                        <span className="min-w-0 truncate text-xs text-[var(--ink-muted)]/70 ml-1">
                                            {dirname}
                                        </span>
                                    )}
                                </button>
                                <button
                                    type="button"
                                    title="在文件目录中展示"
                                    aria-label="在文件目录中展示"
                                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--ink-muted)]/60 opacity-0 transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--accent-warm)] group-hover:opacity-100 focus-visible:opacity-100"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRevealInTree(hit);
                                    }}
                                >
                                    <LocateFixed className="h-3.5 w-3.5" />
                                </button>
                                <div className="shrink-0 flex items-center justify-center w-5 h-5 rounded-full bg-[var(--paper-inset)] text-xs text-[var(--ink-muted)] font-medium">
                                    {hit.matchCount}
                                </div>
                            </div>

                            {/* Match Lines */}
                            {isExpanded && hit.matches.length > 0 && (
                                <div className="flex flex-col">
                                    {hit.matches.map((match, idx) => {
                                        const isActiveMatch = isActiveSearchMatch(activeTarget, hit.path, match.lineNumber);
                                        return (
                                        <div
                                            key={`${hit.path}-${match.lineNumber}-${idx}`}
                                            role="button"
                                            className={`group flex min-h-6 items-start py-0.5 pr-3 pl-[30px] text-2sm hover:text-[var(--ink)] cursor-pointer text-[var(--ink-secondary)] transition-colors ${
                                                isActiveMatch ? 'bg-[var(--accent-warm-subtle)]' : 'hover:bg-[var(--hover-bg)]'
                                            }`}
                                            onClick={() => onMatchClick(hit, match)}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onContextMenu(e, hit);
                                            }}
                                        >
                                            {/* Line number */}
                                            <div className="w-8 shrink-0 text-right text-xs text-[var(--ink-muted)]/60 font-mono pt-[1px] select-none pr-3">
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
                                        );
                                    })}
                                    {hit.matchCount > hit.matches.length && (
                                        <div className="pl-[38px] py-1 text-xs text-[var(--ink-muted)]/50 italic mb-1">
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
