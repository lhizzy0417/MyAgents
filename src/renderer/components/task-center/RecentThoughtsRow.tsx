// RecentThoughtsRow — single-line strip of the latest thoughts, shown
// under the Launcher input when 「想法」 mode is active (PRD §4.2).
//
// Shape is a single horizontal row: most recent thought first, followed by
// a trailing 「查看更多 →」 chip that opens the full Task Center tab. Saving
// a new thought from the input above bumps `refreshKey` and the strip
// re-fetches so the just-saved note slides in as the first chip.
//
// Positioned absolutely by the caller so it hangs below the input without
// changing the parent's vertical layout.

import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { thoughtList } from '@/api/taskCenter';
import { relativeTime } from '@/utils/taskCenterUtils';
import type { Thought } from '@/../shared/types/thought';

interface Props {
  /** Bumped by caller after a thoughtCreate succeeds → triggers refetch. */
  refreshKey: number;
  /** Open the Task Center tab (see App.tsx OPEN_TASK_CENTER listener). */
  onOpenTaskCenter: () => void;
  /** Max number of cards before the 「查看更多」 chip. */
  limit?: number;
}

export function RecentThoughtsRow({
  refreshKey,
  onOpenTaskCenter,
  limit = 3,
}: Props) {
  const [thoughts, setThoughts] = useState<Thought[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Launcher strip is a passive recent-activity view — archived
        // thoughts shouldn't bubble up here even though search would
        // still find them.
        const list = await thoughtList({ limit, archived: 'active' });
        if (!cancelled) {
          setThoughts(list);
          setLoaded(true);
        }
      } catch {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey, limit]);

  // Hide the whole strip until the first fetch resolves, so an empty
  // flicker doesn't appear before data arrives on Launcher mount.
  if (!loaded) return null;

  // Layout contract: no horizontal scroll — each chip shrinks as needed via
  // `flex-1 min-w-0` and truncates text, so the 「更多」 button stays pinned
  // to the right regardless of content length.
  return (
    <div className="flex w-full items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {thoughts.map((t) => (
          <ThoughtChip
            key={t.id}
            thought={t}
            onClick={onOpenTaskCenter}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenTaskCenter}
        className="flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2.5 py-1.5 text-[12px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]"
        title="打开任务中心查看全部想法"
      >
        <span>更多</span>
        <ArrowRight className="h-3 w-3" />
      </button>
    </div>
  );
}

interface ChipProps {
  thought: Thought;
  onClick: () => void;
}

function ThoughtChip({ thought, onClick }: ChipProps) {
  const firstLine = firstNonEmptyLine(thought.content);
  // `flex-1 min-w-0` lets the chip shrink when the row is tight, while
  // `truncate` on the label adds an ellipsis so no chip overflows its slot.
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--line)] bg-[var(--paper-elevated)] px-2.5 py-1.5 text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
      title={thought.content}
    >
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--ink-secondary)] group-hover:text-[var(--ink)]">
        {firstLine || '（空想法）'}
      </span>
      <span className="shrink-0 text-[10px] text-[var(--ink-muted)]/70">
        {relativeTime(thought.createdAt)}
      </span>
    </button>
  );
}

function firstNonEmptyLine(s: string): string {
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim();
    if (line) return line;
  }
  return '';
}

export default RecentThoughtsRow;
