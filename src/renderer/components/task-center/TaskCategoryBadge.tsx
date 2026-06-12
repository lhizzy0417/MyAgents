// TaskCategoryBadge — top-left chip on a task card signalling *how* the
// task runs (its execution mode). Designed to be the first thing the user
// scans: "this is a heartbeat loop" vs "this is a one-shot" vs "this is
// scheduled" vs "this is recurring" is the question the card needs to
// answer in one glance.
//
// Four categories, four icons, four color families — all reuse existing
// DESIGN.md tokens (no new colors introduced):
//
//   loop       → Heart   + --heartbeat   ("心跳循环")
//   once       → Play    + --accent-warm ("一次性")
//   scheduled  → Clock   + --success     ("定时")
//   recurring  → Repeat  + --info        ("周期")
//
// Pair with <TaskStatusBadge> on the top-right: category answers "what
// kind", status answers "where in its lifecycle". The two chips never
// conflict because they carry orthogonal information.
//
// Legacy CronTasks (no `task_id` back-pointer) render as their inferred
// category (derived from CronSchedule kind) with a parenthetical "遗留"
// marker — that way the grid doesn't sprout a fifth unique category
// just for backward compat.

import { Clock, Heart, Play, Repeat } from 'lucide-react';

import type { TaskExecutionMode } from '@/../shared/types/task';

type Category = TaskExecutionMode;

interface CategoryStyle {
  label: string;
  icon: typeof Clock;
  bg: string;
  fg: string;
}

const CATEGORY_STYLE: Record<Category, CategoryStyle> = {
  loop: {
    label: '心跳循环',
    icon: Heart,
    bg: 'bg-[var(--heartbeat-bg)]',
    fg: 'text-[var(--heartbeat)]',
  },
  once: {
    label: '一次性',
    icon: Play,
    bg: 'bg-[var(--accent-warm-subtle)]',
    fg: 'text-[var(--accent-warm)]',
  },
  scheduled: {
    label: '定时',
    icon: Clock,
    bg: 'bg-[var(--success-bg)]',
    fg: 'text-[var(--success)]',
  },
  recurring: {
    label: '周期',
    icon: Repeat,
    bg: 'bg-[var(--info-bg)]',
    fg: 'text-[var(--info)]',
  },
};

interface Props {
  mode: TaskExecutionMode;
  /** Adds a "· 遗留" tail for legacy CronTasks that haven't been upgraded. */
  legacy?: boolean;
  compact?: boolean;
}

export function TaskCategoryBadge({ mode, legacy, compact }: Props) {
  const style = CATEGORY_STYLE[mode];
  const Icon = style.icon;
  const size = 'text-xs'; // compact 与常规已同档（Part 1 合并 10→11→12 的遗留三元塌缩）
  // Height / padding mirror TaskStatusBadge so the two chips sit
  // perfectly aligned in the card's header row (see status-badge.tsx
  // for the rationale on leading-none + fixed h-5).
  const height = compact ? 'h-[18px]' : 'h-5';
  const padding = compact ? 'px-1.5' : 'px-2';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-[var(--radius-sm)] font-medium leading-none ${style.bg} ${style.fg} ${padding} ${height} ${size}`}
    >
      <Icon className="h-3 w-3" strokeWidth={1.75} />
      {style.label}
      {legacy && (
        <span className="text-[var(--ink-muted)]/80" aria-label="遗留任务">
          · 遗留
        </span>
      )}
    </span>
  );
}

export default TaskCategoryBadge;
