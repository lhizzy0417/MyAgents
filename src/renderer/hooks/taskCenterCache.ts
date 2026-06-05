/**
 * Module-level stale-while-revalidate (SWR) cache for Task Center data.
 *
 * Why: `useTaskCenterData` is re-mounted on every new Launcher tab. Without a
 * cache each mount starts empty (`isLoading=true` → spinner in RecentTasks) and
 * fires a fresh 6-way `Promise.all` fan-out (sessions / cron / tasks /
 * background / agentStatuses / agents). That is the "新 Tab 未就绪那一拍" — see
 * specs/research/0605_research_frontend_perf_architecture_deep_review.md §10 (C-2).
 *
 * Design (minimal new concepts): one module-level entry holds the last-displayed
 * data + a timestamp. The hook seeds its initial state from here (instant render,
 * no spinner) and writes back on every state change via a SINGLE effect — pit of
 * success: every update path (full fetch + 5 partial refreshers) flows to the
 * cache automatically, with no per-refresher bookkeeping to forget. On mount we
 * still revalidate in the background (silently) so data converges to disk truth;
 * we skip even that when the cache is within `ttlMs` (rapid tab opening). The
 * mount decision is a pure function so the SWR logic is unit-testable.
 *
 * Scope: caches DISPLAY data only. It deliberately does NOT touch the Launcher's
 * MCP / provider / agent-config load, which feeds first-message correctness and
 * must stay eager (the §10 invariant).
 */

import type { SessionMetadata } from '@/api/sessionClient';
import type { CronTask } from '@/types/cronTask';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import type { Task } from '../../shared/types/task';
import type { AgentConfig } from '../../shared/types/agent';

export interface TaskCenterCacheData {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    tasks: Task[];
    backgroundSessionIds: string[];
    agentStatuses: AgentStatusMap;
    agents: AgentConfig[];
}

export interface TaskCenterCacheEntry {
    data: TaskCenterCacheData;
    updatedAt: number;
}

let entry: TaskCenterCacheEntry | null = null;

export function readTaskCenterCache(): TaskCenterCacheEntry | null {
    return entry;
}

export function writeTaskCenterCache(data: TaskCenterCacheData, now: number): void {
    entry = { data, updatedAt: now };
}

/**
 * Deleted-session tombstones, shared across all hook instances. The cache is
 * module-global but the hook's per-instance deleted-id Set could not suppress a
 * just-deleted session in a sibling Launcher tab whose revalidate transiently
 * re-returns it (cross-tab resurrection). Tombstones live for the app session;
 * session ids are unique UUIDs, so the set never needs runtime pruning.
 */
const deletedSessionIds = new Set<string>();

export function markSessionDeleted(id: string): void {
    deletedSessionIds.add(id);
}

export function isSessionDeleted(id: string): boolean {
    return deletedSessionIds.has(id);
}

export interface TaskCenterMountDecision {
    /** Seed the hook's initial state from this (null → start empty, first-ever mount). */
    seedData: TaskCenterCacheData | null;
    /** Initial `isLoading` — only a cache miss shows the spinner. */
    initialLoading: boolean;
    /** Whether to fetch on mount at all. */
    revalidate: boolean;
    /** When revalidating with seeded data, do it silently (no spinner / no error surface). */
    silent: boolean;
}

/**
 * Pure SWR decision for what a fresh mount should do given the current cache:
 * - no cache        → loud load (spinner), as before;
 * - cache + fresh    → serve instantly, skip revalidate (rapid tab opens);
 * - cache + stale    → serve instantly, revalidate silently in the background.
 */
export function decideTaskCenterMount(
    cache: TaskCenterCacheEntry | null,
    now: number,
    ttlMs: number,
): TaskCenterMountDecision {
    if (!cache) {
        return { seedData: null, initialLoading: true, revalidate: true, silent: false };
    }
    // `age >= 0` guard: a backwards clock jump (NTP correction) would make a
    // future `updatedAt` produce a negative age that is always `< ttlMs` →
    // "fresh forever". Treat a future timestamp as stale so we still revalidate.
    const age = now - cache.updatedAt;
    const fresh = age >= 0 && age < ttlMs;
    return { seedData: cache.data, initialLoading: false, revalidate: !fresh, silent: true };
}

/** Test-only: reset the module cache + tombstones between cases. */
export function __resetTaskCenterCacheForTest(): void {
    entry = null;
    deletedSessionIds.clear();
}
