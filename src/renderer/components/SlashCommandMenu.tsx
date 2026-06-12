// SlashCommandMenu.tsx
// Content of the `/` command dropdown — positioning + outside-click are the
// caller's responsibility (wraps this in `<Popover>`). Keeping this pure
// means the primitive owns all layout/dismissal logic and the menu can be
// anchored to different triggers without duplicating chrome.

import { useEffect, useRef } from 'react';

// Import SlashCommand type from shared module to avoid duplication
import type { SlashCommand } from '../../shared/slashCommands';

// Re-export for consumers that import from this file
export type { SlashCommand };

interface SlashCommandMenuProps {
    commands: SlashCommand[]; // Already filtered commands
    selectedIndex: number;
    onSelect: (command: SlashCommand) => void;
    isEmpty?: boolean; // True when search found no results
}

export default function SlashCommandMenu({
    commands,
    selectedIndex,
    onSelect,
    isEmpty = false,
}: SlashCommandMenuProps) {
    // Ref to track the selected item for auto-scroll
    const selectedItemRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to keep selected item visible when navigating with keyboard
    useEffect(() => {
        if (selectedItemRef.current) {
            selectedItemRef.current.scrollIntoView({
                block: 'nearest',
                behavior: 'smooth',
            });
        }
    }, [selectedIndex]);

    // Empty state: show "未找到指令" when no matches
    if (isEmpty || commands.length === 0) {
        return (
            <div className="w-80 max-h-64 overflow-auto">
                <div className="px-3 py-2 text-sm text-[var(--ink-muted)]">
                    未找到指令
                </div>
            </div>
        );
    }

    return (
        <div className="w-80 max-h-64 overflow-auto">
            {commands.map((cmd, index) => (
                <div
                    key={`${cmd.source}-${cmd.name}`}
                    ref={index === selectedIndex ? selectedItemRef : null}
                    className={`flex items-center gap-3 px-3 py-2 cursor-pointer text-sm ${index === selectedIndex
                        ? 'bg-[var(--accent)]/10 text-[var(--ink)]'
                        : 'text-[var(--ink-muted)] hover:bg-[var(--hover-bg)]'
                        }`}
                    onClick={() => onSelect(cmd)}
                >
                    <span className="font-medium text-[var(--ink)] whitespace-nowrap">/{cmd.name}</span>
                    {cmd.source === 'skill' && (
                        <span className="text-xs text-[var(--ink-muted)]/60 bg-[var(--paper-inset)] px-1.5 py-0.5 rounded shrink-0">
                            skill
                        </span>
                    )}
                    <span
                        className="text-[var(--ink-muted)] text-xs truncate flex-1"
                        title={cmd.description}
                    >
                        {cmd.description}
                    </span>
                </div>
            ))}
        </div>
    );
}

// Helper function to filter and sort commands (used by SimpleChatInput)
//
// Built-in/system commands (`source: 'builtin'`, e.g. /loop, /compact) always
// rank above user skills & commands so the app's own capabilities surface
// first. Within a tier the existing order is preserved (alphabetical with no
// query; prefix-match-then-alphabetical when filtering).
export function filterAndSortCommands(commands: SlashCommand[], query: string): SlashCommand[] {
    const q = query.toLowerCase();
    const tier = (c: SlashCommand) => (c.source === 'builtin' ? 0 : 1);

    if (!q) {
        // No query: builtins first, then alphabetical within each tier
        return [...commands].sort((a, b) => tier(a) - tier(b) || a.name.localeCompare(b.name));
    }

    return commands
        .filter(cmd =>
            cmd.name.toLowerCase().includes(q) ||
            cmd.description.toLowerCase().includes(q)
        )
        .sort((a, b) => {
            // Builtins first, regardless of match quality
            const tierDiff = tier(a) - tier(b);
            if (tierDiff !== 0) return tierDiff;

            const aName = a.name.toLowerCase();
            const bName = b.name.toLowerCase();
            const aStartsWith = aName.startsWith(q);
            const bStartsWith = bName.startsWith(q);

            // Prefix match comes first
            if (aStartsWith && !bStartsWith) return -1;
            if (!aStartsWith && bStartsWith) return 1;

            // Then sort alphabetically
            return aName.localeCompare(bName);
        });
}
