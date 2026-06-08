// Legacy cron → new Task upgrade (PRD §11.4, §16.2).
//
// The whole pipeline — create Thought, derive TaskCreateDirectInput,
// write both back-pointers, roll back on any failure — lives in Rust
// (`src-tauri/src/legacy_upgrade.rs`) so the cross-module type drift we
// hit twice in TypeScript (deadline ISO/i64, run_mode snake/kebab)
// can't happen again: conversions are strongly typed Rust-to-Rust and
// any future field mismatch fails at `cargo check`, not at the user's
// open-overlay moment.
//
// This file is now a thin renderer-side shim: resolve `workspace_path
// → workspace_id` from the projects list (the config is renderer-
// owned), then call the Rust primitive.

import { taskCenterAvailable, taskUpgradeLegacyCron } from '@/api/taskCenter';
import { workspacePathsEqual } from '@/../shared/workspacePath';
import type { Project } from '@/config/types';
import type { Task } from '@/../shared/types/task';

/** Minimal subset of the raw CronTask object we need in the renderer
 *  — we only read `id`, `workspacePath`, and `prompt` (for eligibility).
 *  Any actual upgrade conversion now happens server-side. */
export interface LegacyCronRaw {
  id?: string;
  prompt?: string;
  workspacePath?: string;
  /** Tolerated for defense — a few code paths surface snake_case. */
  workspace_path?: string;
  [key: string]: unknown;
}

export interface UpgradeResult {
  task: Task;
}

function getWorkspacePath(legacy: LegacyCronRaw): string {
  return String(legacy.workspacePath ?? legacy.workspace_path ?? '').trim();
}

function resolveWorkspaceId(path: string, projects: Project[]): string | null {
  if (!path) return null;
  // #320: projects.json keeps the native Windows dialog path (backslashes)
  // while a cron's workspacePath is POSIX-style — never compare with raw `===`.
  return projects.find((p) => workspacePathsEqual(p.path, path))?.id ?? null;
}

/** Cheap pre-flight: does this row have enough metadata for the Rust
 *  primitive to succeed without the user being prompted? Used by the
 *  auto-upgrade sweep to skip rows that would deterministically fail
 *  (missing prompt, deleted workspace). Manual upgrade surfaces the
 *  actual Rust error for the rest. */
export function canAutoUpgrade(legacy: LegacyCronRaw, projects: Project[]): boolean {
  if (!String(legacy.id ?? '').trim()) return false;
  if (!String(legacy.prompt ?? '').trim()) return false;
  return resolveWorkspaceId(getWorkspacePath(legacy), projects) !== null;
}

export async function upgradeLegacyCron(
  legacy: LegacyCronRaw,
  projects: Project[],
): Promise<UpgradeResult> {
  const cronTaskId = String(legacy.id ?? '').trim();
  if (!cronTaskId) throw new Error('缺少 CronTask id，无法升级');
  const workspacePath = getWorkspacePath(legacy);
  if (!workspacePath) throw new Error('缺少工作区路径，无法升级');
  const workspaceId = resolveWorkspaceId(workspacePath, projects);
  if (!workspaceId) {
    throw new Error(
      `找不到工作区：${workspacePath}。请先在启动页添加该工作区，然后重试升级。`,
    );
  }
  return taskUpgradeLegacyCron(cronTaskId, workspaceId);
}

/**
 * Rust `upgrade_legacy_cron` returns an error prefixed `ALREADY_LINKED:`
 * when the losing side of a concurrent-upgrade race hits the cron's
 * `set_task_id(..., require_null=true)` guard. This is **not** a failure —
 * the other caller did the work, the cron now points at a valid Task.
 * Without this detection, the app-startup sweep + Task Center mount
 * sweep racing would surface a misleading "自动升级失败" toast on one
 * side even though the cron is now properly migrated.
 * (v0.1.69 cross-review W1)
 */
export function isBenignAlreadyLinked(err: unknown): boolean {
  return String(err).includes('ALREADY_LINKED');
}

/**
 * App-startup legacy CronTask sweep (PRD §11.4 / v0.1.69 UX round).
 *
 * Fetches every CronTask without a `task_id` back-pointer and upgrades
 * each eligible row to a new-model Task. Runs once at app startup so
 * the Launcher's 「我的任务」 tab — which now reads Task[] instead of
 * raw CronTask[] — has data even for users who never opened the Task
 * Center page.
 *
 * Eligibility mirrors `canAutoUpgrade`: a resolvable workspace + a
 * non-empty prompt. Rows failing eligibility remain as "遗留" entries
 * in the Task Center's legacy list and can be upgraded manually from
 * there.
 *
 * Returns a small stats object for logging / telemetry; errors are
 * swallowed (best-effort sweep — one bad row shouldn't bubble up to
 * the Launcher mount path).
 */
export async function sweepAppStartupLegacyCrons(
  projects: Project[],
): Promise<{ upgraded: number; skippedIneligible: number; failed: number }> {
  if (!taskCenterAvailable()) {
    return { upgraded: 0, skippedIneligible: 0, failed: 0 };
  }
  let rawCrons: Array<Record<string, unknown>>;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    rawCrons = (await invoke<Record<string, unknown>[]>(
      'cmd_get_cron_tasks',
    )) as Array<Record<string, unknown>>;
  } catch (err) {
    console.warn('[legacy-sweep] fetch crons failed', err);
    return { upgraded: 0, skippedIneligible: 0, failed: 0 };
  }

  // Filter to rows without a Task back-pointer. Defend against snake
  // vs camel casing since the Rust side serialises camelCase but older
  // JSON shapes may surface either.
  const legacy = rawCrons.filter(
    (t) => !t.taskId && !t.task_id,
  ) as LegacyCronRaw[];

  let upgraded = 0;
  let skippedIneligible = 0;
  let failed = 0;
  for (const row of legacy) {
    if (!canAutoUpgrade(row, projects)) {
      skippedIneligible += 1;
      continue;
    }
    try {
      await upgradeLegacyCron(row, projects);
      upgraded += 1;
    } catch (err) {
      if (isBenignAlreadyLinked(err)) {
        // TaskCenter mount sweep won the race — benign. Count as
        // "work done" (the cron IS migrated now) rather than a failure.
        upgraded += 1;
        continue;
      }
      console.warn('[legacy-sweep] upgrade failed for', row.id, err);
      failed += 1;
    }
  }
  return { upgraded, skippedIneligible, failed };
}
