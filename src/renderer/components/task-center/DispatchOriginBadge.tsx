// DispatchOriginBadge — label distinguishing "direct" from "ai-aligned"
// task creation path. Per PRD §7.3 and v1.4 no-emoji rule.
//
// Two visual modes:
//   • default  — pill-shaped status chip, used in the detail overlay
//     header alongside TaskStatusBadge so both read as "chips".
//   • compact  — plain text with a `title=` tooltip, used in the list
//     card's meta row. Meta rows are a `·`-separated line of auxiliary
//     info (time, executor, mode) and a pill here would steal visual
//     weight from the actual status badge. Keeping dispatch-origin as
//     flat meta text lets the status badge own the "chip" vocabulary.

import type { TaskDispatchOrigin } from '@/../shared/types/task';

interface Props {
  origin: TaskDispatchOrigin;
  compact?: boolean;
}

export function DispatchOriginBadge({ origin, compact }: Props) {
  const label = origin === 'direct' ? '直接派发' : '对齐讨论';
  const title =
    origin === 'direct'
      ? '直接派发：以想法原文为 task.md'
      : '对齐讨论：通过 /task-alignment 生成完整四份文档';

  if (compact) {
    // Plain meta text — no bg, no pill, no accent. Inherits color from
    // the surrounding meta row so it reads as one continuous line.
    return (
      <span className="text-xs text-[var(--ink-muted)]" title={title}>
        {label}
      </span>
    );
  }

  const bgCls =
    origin === 'direct'
      ? 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'
      : 'bg-[var(--accent-warm-subtle)] text-[var(--accent-warm)]';
  return (
    <span
      className={`inline-flex items-center rounded-[var(--radius-sm)] px-2 py-0.5 text-xs font-medium ${bgCls}`}
      title={title}
    >
      {label}
    </span>
  );
}

export default DispatchOriginBadge;
