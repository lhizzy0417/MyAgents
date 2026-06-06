/**
 * Single app-level store for Task Center data (P2).
 *
 * Task-center data (sessions / cronTasks / tasks / backgroundSessions /
 * agentStatuses / agents) is app-GLOBAL — none of it is tab-scoped. Previously
 * `useTaskCenterData` owned it PER Launcher mount (its own state + a 6-way
 * Promise.all fan-out + its own Tauri listeners), and C-2 bolted a module-level
 * SWR cache on top to make re-mounts instant. That cache was a band-aid for the
 * real mismatch: global data with a per-instance owner.
 *
 * This store gives that data ONE owner: a single fetch lifecycle, listeners
 * registered ONCE (ref-counted by live subscribers), always-warm state, and
 * `computeSessionTagsMap`/`computeCronBotInfoMap` computed once for everyone.
 * `useTaskCenterData` becomes a thin `useSyncExternalStore` subscriber, so a new
 * Launcher tab subscribes to already-warm data — instant, zero fetch, no
 * spinner — which supersedes and removes `taskCenterCache.ts`.
 *
 * Carried-over invariants from C-2:
 *  - tombstones: a deleted session must not resurrect (cross-instance) if a
 *    revalidate transiently re-returns it;
 *  - degraded fetch: a PARTIAL fetch failure must NOT blank a good slice — the
 *    prior value is preserved (better than the old per-instance behaviour).
 *
 * Scope: DISPLAY data only. The Launcher's MCP / provider / agent-config load
 * (first-message correctness) stays in Launcher, eager, and never flows here.
 */

import { deleteSession as deleteSessionApi, getSessions, type SessionMetadata } from '@/api/sessionClient';
import { getAllCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import { taskCenterAvailable, taskList } from '@/api/taskCenter';
import { deactivateSession } from '@/api/tauriClient';
import { loadAppConfig } from '@/config/configService';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import { perfMark } from '@/utils/perfMark';
import { RENDERER_PERF_PHASE } from '../../shared/perfTrace';
import { CUSTOM_EVENTS } from '../../shared/constants';
import type { CronTask } from '@/types/cronTask';
import type { Task } from '../../shared/types/task';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';

// ===== Public types (re-exported by useTaskCenterData for back-compat) =====

export type SessionTag =
    | { type: 'im'; platform: string }
    | { type: 'cron' }
    | { type: 'background' };

export interface TaskCenterData {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    tasks: Task[];
    sessionTagsMap: Map<string, SessionTag[]>;
    cronBotInfoMap: Map<string, { name: string; platform: string }>;
    isLoading: boolean;
    error: string | null;
    refresh: (scope?: TaskCenterRefreshScope, options?: TaskCenterRefreshOptions) => void;
    actions: TaskCenterActions;
}

export type TaskCenterRefreshScope = 'all' | 'sessions' | 'cronTasks' | 'tasks' | 'backgroundSessions' | 'agentStatuses';

export interface TaskCenterRefreshOptions {
    force?: boolean;
    minIntervalMs?: number;
    reason?: string;
    silent?: boolean;
}

export interface TaskCenterActions {
    deleteSession: (sessionId: string) => Promise<boolean>;
    refreshSessions: () => void;
    refreshCronTasks: () => void;
    refreshTasks: () => void;
}

export const TASK_CENTER_FRESHNESS_TTL_MS = 2_000;

const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;

// ===== Pure helpers (unit-tested) =====

export const sortSessionsByLastActive = (data: SessionMetadata[]): SessionMetadata[] =>
    [...data].sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());

/** Drop tombstoned sessions (deleted in any tab); pure. */
export function filterTombstoned(data: SessionMetadata[], deleted: ReadonlySet<string>): SessionMetadata[] {
    if (deleted.size === 0) return data;
    return data.filter((s) => !deleted.has(s.id));
}

/** Compute session→tags map (im / cron / background). Pure. */
export function computeSessionTagsMap(
    sessions: SessionMetadata[],
    cronTasks: CronTask[],
    backgroundSessionIds: string[],
    agentStatuses: AgentStatusMap,
): Map<string, SessionTag[]> {
    const map = new Map<string, SessionTag[]>();
    const imSessionPlatformMap = new Map<string, string>();
    for (const agentStatus of Object.values(agentStatuses)) {
        for (const channel of agentStatus.channels) {
            if (channel.status !== 'online' && channel.status !== 'connecting') continue;
            for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
            }
        }
    }
    const cronSessionIds = new Set<string>();
    const bgSessionIds = new Set<string>(backgroundSessionIds);
    for (const t of cronTasks) {
        if (t.status !== 'running') continue;
        const sid = t.internalSessionId || t.sessionId;
        if (t.schedule?.kind === 'at') bgSessionIds.add(sid);
        else cronSessionIds.add(sid);
    }
    for (const session of sessions) {
        const tags: SessionTag[] = [];
        const imPlatform = imSessionPlatformMap.get(session.id);
        if (imPlatform) tags.push({ type: 'im', platform: imPlatform });
        if (cronSessionIds.has(session.id)) tags.push({ type: 'cron' });
        if (bgSessionIds.has(session.id)) tags.push({ type: 'background' });
        if (tags.length > 0) map.set(session.id, tags);
    }
    return map;
}

/** Compute channel-id → {name, platform} from agents[].channels[]. Pure. */
export function computeCronBotInfoMap(agents: AgentConfig[]): Map<string, { name: string; platform: string }> {
    const map = new Map<string, { name: string; platform: string }>();
    for (const agent of agents) {
        for (const channel of (agent.channels ?? [])) {
            map.set(channel.id, { name: channel.name || agent.name, platform: channel.type });
        }
    }
    return map;
}

/** `taskList` is Tauri-only; browser dev mode returns [] silently. */
async function safeTaskList(): Promise<Task[]> {
    if (!taskCenterAvailable()) return [];
    try {
        return await taskList({});
    } catch (err) {
        console.warn('[taskCenterStore] taskList failed', err);
        return [];
    }
}

// ===== Store internals =====

interface StoreState {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    tasks: Task[];
    backgroundSessionIds: string[];
    agentStatuses: AgentStatusMap;
    agents: AgentConfig[];
    isLoading: boolean;
    error: string | null;
}

let state: StoreState = {
    sessions: [],
    cronTasks: [],
    tasks: [],
    backgroundSessionIds: [],
    agentStatuses: {},
    agents: [],
    isLoading: true,
    error: null,
};

const listeners = new Set<() => void>();
const deletedSessionIds = new Set<string>(); // cross-instance tombstones

let started = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
const refreshTimers: Record<string, ReturnType<typeof setTimeout> | null> = {};
let cleanupTauriListeners: (() => void) | null = null;
let lastFullFetchAt = 0;

// per-scope request sequence (latest-wins) — protects against out-of-order async
let seq = 0;
const latestSeqByScope: Partial<Record<TaskCenterRefreshScope, number>> = {};
function startRequest(scope: TaskCenterRefreshScope): number {
    const s = ++seq;
    latestSeqByScope[scope] = s;
    if (scope === 'all') {
        latestSeqByScope.sessions = s;
        latestSeqByScope.cronTasks = s;
        latestSeqByScope.tasks = s;
        latestSeqByScope.backgroundSessions = s;
        latestSeqByScope.agentStatuses = s;
    }
    return s;
}
const isLatest = (scope: TaskCenterRefreshScope, s: number): boolean => latestSeqByScope[scope] === s;

// Memoized derived maps — recomputed only when their inputs change by reference.
let mapsCache: {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    backgroundSessionIds: string[];
    agentStatuses: AgentStatusMap;
    agents: AgentConfig[];
    sessionTagsMap: Map<string, SessionTag[]>;
    cronBotInfoMap: Map<string, { name: string; platform: string }>;
} | null = null;

let snapshot!: TaskCenterData; // initialised after `refresh`/`actions` exist (buildSnapshot reads them → avoid TDZ)

function buildSnapshot(): TaskCenterData {
    if (
        !mapsCache ||
        mapsCache.sessions !== state.sessions ||
        mapsCache.cronTasks !== state.cronTasks ||
        mapsCache.backgroundSessionIds !== state.backgroundSessionIds ||
        mapsCache.agentStatuses !== state.agentStatuses ||
        mapsCache.agents !== state.agents
    ) {
        mapsCache = {
            sessions: state.sessions,
            cronTasks: state.cronTasks,
            backgroundSessionIds: state.backgroundSessionIds,
            agentStatuses: state.agentStatuses,
            agents: state.agents,
            sessionTagsMap: computeSessionTagsMap(state.sessions, state.cronTasks, state.backgroundSessionIds, state.agentStatuses),
            cronBotInfoMap: computeCronBotInfoMap(state.agents),
        };
    }
    return {
        sessions: state.sessions,
        cronTasks: state.cronTasks,
        tasks: state.tasks,
        sessionTagsMap: mapsCache.sessionTagsMap,
        cronBotInfoMap: mapsCache.cronBotInfoMap,
        isLoading: state.isLoading,
        error: state.error,
        refresh,
        actions,
    };
}

function setState(patch: Partial<StoreState>): void {
    state = { ...state, ...patch };
    snapshot = buildSnapshot();
    for (const l of listeners) l();
}

// ===== Fetch + refreshers =====

async function fetchData(retryCount = 0, silent = false): Promise<void> {
    const requestSeq = startRequest('all');
    if (retryCount === 0 && !silent) setState({ isLoading: true, error: null });

    try {
        // Per-source success tracking: a PARTIAL failure must not blank a good
        // slice — we keep the prior value for any source that failed.
        const ok = { sessions: true, cron: true, tasks: true, bg: true, agents: true, status: true };
        const agentStatusPromise = isTauriEnvironment()
            ? import('@tauri-apps/api/core')
                .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                .catch(() => { ok.status = false; return state.agentStatuses; })
            : Promise.resolve({} as AgentStatusMap);

        const [sessionsData, cronData, newTasks, bgSessions, agentStatusResult, appConfig] = await Promise.all([
            getSessions().catch(() => { ok.sessions = false; return state.sessions; }),
            getAllCronTasks().catch(() => { ok.cron = false; return state.cronTasks; }),
            safeTaskList().catch(() => { ok.tasks = false; return state.tasks; }),
            getBackgroundSessions().catch(() => { ok.bg = false; return state.backgroundSessionIds; }),
            agentStatusPromise,
            loadAppConfig().catch(() => { ok.agents = false; return null; }),
        ]);

        if (!isLatest('all', requestSeq)) return; // superseded by a newer full fetch

        const patch: Partial<StoreState> = {};
        if (ok.sessions) patch.sessions = sortSessionsByLastActive(filterTombstoned(sessionsData, deletedSessionIds));
        if (ok.cron) patch.cronTasks = cronData;
        if (ok.tasks) patch.tasks = newTasks;
        if (ok.bg) patch.backgroundSessionIds = bgSessions;
        if (ok.status) patch.agentStatuses = agentStatusResult;
        if (ok.agents) patch.agents = appConfig?.agents ?? [];
        patch.isLoading = false;
        if (!silent) patch.error = null;
        setState(patch);
        lastFullFetchAt = Date.now();
        perfMark(RENDERER_PERF_PHASE.tabDataReady, { surface: 'taskcenter' });
    } catch (err) {
        console.error('[taskCenterStore] Failed to load data:', err);
        if (!silent && retryCount < MAX_AUTO_RETRIES) {
            retryTimer = setTimeout(() => { void fetchData(retryCount + 1, silent); }, RETRY_DELAY_MS);
        } else if (!silent) {
            setState({ isLoading: false, error: '加载失败，请稍后重试' });
        } else {
            setState({ isLoading: false });
        }
    }
}

function refreshSessionsNow(): void {
    const s = startRequest('sessions');
    getSessions().then((data) => {
        if (!isLatest('sessions', s)) return;
        setState({ sessions: sortSessionsByLastActive(filterTombstoned(data, deletedSessionIds)) });
    }).catch((err) => console.warn('[taskCenterStore] refresh sessions failed:', err));
}
function refreshCronTasksNow(): void {
    const s = startRequest('cronTasks');
    getAllCronTasks().then((data) => { if (isLatest('cronTasks', s)) setState({ cronTasks: data }); })
        .catch((err) => console.warn('[taskCenterStore] refresh cron failed:', err));
}
function refreshTasksNow(): void {
    const s = startRequest('tasks');
    void safeTaskList().then((data) => { if (isLatest('tasks', s)) setState({ tasks: data }); });
}
function refreshBackgroundNow(): void {
    const s = startRequest('backgroundSessions');
    getBackgroundSessions().then((data) => { if (isLatest('backgroundSessions', s)) setState({ backgroundSessionIds: data }); })
        .catch((err) => console.warn('[taskCenterStore] refresh background failed:', err));
}
function refreshAgentStatusNow(): void {
    const s = startRequest('agentStatuses');
    if (!isTauriEnvironment()) return;
    import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status')
            .then((data) => { if (isLatest('agentStatuses', s)) setState({ agentStatuses: data }); })
            .catch((err) => console.warn('[taskCenterStore] refresh agent status failed:', err)))
        .catch((err) => console.warn('[taskCenterStore] load tauri api failed:', err));
}

function debounced(key: string, fn: () => void, delayMs: number): void {
    if (refreshTimers[key]) clearTimeout(refreshTimers[key]!);
    refreshTimers[key] = setTimeout(() => { refreshTimers[key] = null; fn(); }, delayMs);
}

export const refresh = (scope: TaskCenterRefreshScope = 'all', options: TaskCenterRefreshOptions = {}): void => {
    if (!options.force && options.minIntervalMs && scope === 'all') {
        if (Date.now() - lastFullFetchAt < options.minIntervalMs) return;
    }
    switch (scope) {
        case 'sessions': return refreshSessionsNow();
        case 'cronTasks': return refreshCronTasksNow();
        case 'tasks': return refreshTasksNow();
        case 'backgroundSessions': return refreshBackgroundNow();
        case 'agentStatuses': return refreshAgentStatusNow();
        default: void fetchData(0, options.silent ?? false);
    }
};

export const actions: TaskCenterActions = {
    deleteSession: async (sessionId: string) => {
        const success = await deleteSessionApi(sessionId);
        if (!success) return false;
        deletedSessionIds.add(sessionId); // tombstone — survives across all subscribers
        setState({ sessions: state.sessions.filter((s) => s.id !== sessionId) });
        try {
            await deactivateSession(sessionId);
        } catch (err) {
            console.warn('[taskCenterStore] Failed to deactivate deleted session:', err);
        }
        refresh('sessions', { force: true, reason: 'delete-session', silent: true });
        return true;
    },
    refreshSessions: () => refresh('sessions', { force: true, silent: true }),
    refreshCronTasks: () => refresh('cronTasks', { force: true, silent: true }),
    refreshTasks: () => refresh('tasks', { force: true, silent: true }),
};

// First snapshot — built now that `refresh` and `actions` are defined
// (buildSnapshot references them; building at the top-level declaration would
// hit the temporal dead zone).
snapshot = buildSnapshot();

// ===== Lifecycle (ref-counted by subscribers) =====

function registerTauriListeners(): void {
    if (!isTauriEnvironment()) return;
    const ac = new AbortController();
    const onSessionTitle = () => debounced('sessions', refreshSessionsNow, 300);
    window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, onSessionTitle);

    void listenWithCleanup('session:background-complete', () => {
        debounced('background', refreshBackgroundNow, 500);
        debounced('sessions', refreshSessionsNow, 500);
    }, ac.signal);
    void listenWithCleanup('cron:task-stopped', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('cron:task-started', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('cron:execution-complete', () => {
        debounced('cron', refreshCronTasksNow, 500);
        debounced('sessions', refreshSessionsNow, 500);
    }, ac.signal);
    void listenWithCleanup('cron:scheduler-started', () => {
        debounced('cron', refreshCronTasksNow, 500);
        debounced('sessions', refreshSessionsNow, 500);
    }, ac.signal);
    void listenWithCleanup('cron:task-deleted', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('cron:task-updated', () => debounced('cron', refreshCronTasksNow, 500), ac.signal);
    void listenWithCleanup('agent:status-changed', () => {
        debounced('agent', refreshAgentStatusNow, 1000);
        debounced('sessions', refreshSessionsNow, 1000);
    }, ac.signal);
    void listenWithCleanup('task:status-changed', () => debounced('tasks', refreshTasksNow, 500), ac.signal);

    cleanupTauriListeners = () => {
        ac.abort();
        window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, onSessionTitle);
    };
}

function ensureStarted(): void {
    if (started) return;
    started = true;
    registerTauriListeners();
    void fetchData(0); // initial load (once; subsequent subscribers get warm data)
    intervalTimer = setInterval(() => { void fetchData(0, true); }, BACKGROUND_REFRESH_INTERVAL_MS);
}

function maybeStop(): void {
    if (listeners.size > 0) return;
    // No live subscribers → stop background work, but KEEP data warm so the next
    // mount is still instant.
    started = false;
    cleanupTauriListeners?.();
    cleanupTauriListeners = null;
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const k of Object.keys(refreshTimers)) {
        if (refreshTimers[k]) { clearTimeout(refreshTimers[k]!); refreshTimers[k] = null; }
    }
}

export function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    ensureStarted();
    return () => {
        listeners.delete(listener);
        maybeStop();
    };
}

export function getSnapshot(): TaskCenterData {
    return snapshot;
}

/** Test-only: reset all module state between cases. */
export function __resetTaskCenterStoreForTest(): void {
    state = { sessions: [], cronTasks: [], tasks: [], backgroundSessionIds: [], agentStatuses: {}, agents: [], isLoading: true, error: null };
    listeners.clear();
    deletedSessionIds.clear();
    mapsCache = null;
    snapshot = buildSnapshot();
    started = false;
    lastFullFetchAt = 0;
    seq = 0;
    cleanupTauriListeners?.();
    cleanupTauriListeners = null;
    if (intervalTimer) { clearInterval(intervalTimer); intervalTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    for (const k of Object.keys(refreshTimers)) {
        if (refreshTimers[k]) { clearTimeout(refreshTimers[k]!); refreshTimers[k] = null; }
    }
    for (const k of Object.keys(latestSeqByScope)) delete latestSeqByScope[k as TaskCenterRefreshScope];
}
