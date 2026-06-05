/**
 * useTaskCenterData - Shared hook for Task Center data fetching,
 * event listening, and tag computation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { deleteSession as deleteSessionApi, getSessions, type SessionMetadata } from '@/api/sessionClient';
import { getAllCronTasks, getBackgroundSessions } from '@/api/cronTaskClient';
import { taskCenterAvailable, taskList } from '@/api/taskCenter';
import { deactivateSession } from '@/api/tauriClient';
import { loadAppConfig } from '@/config/configService';
import { isTauriEnvironment } from '@/utils/browserMock';
import { listenWithCleanup } from '@/utils/tauriListen';
import type { CronTask } from '@/types/cronTask';
import type { Task } from '../../shared/types/task';
import type { AgentConfig } from '../../shared/types/agent';
import type { AgentStatusMap } from '@/hooks/useAgentStatuses';
import { extractPlatformDisplay } from '@/utils/taskCenterUtils';
import { perfMark } from '@/utils/perfMark';
import { readTaskCenterCache, writeTaskCenterCache, decideTaskCenterMount, markSessionDeleted, isSessionDeleted } from '@/hooks/taskCenterCache';
import { CUSTOM_EVENTS } from '../../shared/constants';

// ===== Types =====

export type SessionTag =
    | { type: 'im'; platform: string }
    | { type: 'cron' }
    | { type: 'background' };

export interface TaskCenterData {
    sessions: SessionMetadata[];
    cronTasks: CronTask[];
    /** New-model Tasks (v0.1.69). Populated alongside cronTasks — crons
     *  are the legacy surface, tasks are the primary Launcher tab now. */
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

interface UseTaskCenterDataOptions {
    isActive?: boolean;
}

// Constants
const MAX_AUTO_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const BACKGROUND_REFRESH_INTERVAL_MS = 60_000;
export const TASK_CENTER_FRESHNESS_TTL_MS = 2_000;

const sortSessionsByLastActive = (data: SessionMetadata[]) =>
    [...data].sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());

/** `taskList` is Tauri-only; browser dev mode returns [] silently. */
async function safeTaskList(): Promise<Task[]> {
    if (!taskCenterAvailable()) return [];
    try {
        return await taskList({});
    } catch (err) {
        console.warn('[useTaskCenterData] taskList failed', err);
        return [];
    }
}

export function useTaskCenterData({ isActive }: UseTaskCenterDataOptions): TaskCenterData {
    // SWR: decide once at mount what to do given the module cache. Cache hit →
    // seed state instantly (no spinner) and revalidate silently; cache miss →
    // start empty and do the loud first load. See taskCenterCache.ts.
    const [mountDecision] = useState(() =>
        decideTaskCenterMount(readTaskCenterCache(), Date.now(), TASK_CENTER_FRESHNESS_TTL_MS));

    const [sessions, setSessions] = useState<SessionMetadata[]>(() =>
        (mountDecision.seedData?.sessions ?? []).filter(s => !isSessionDeleted(s.id)));
    const [cronTasks, setCronTasks] = useState<CronTask[]>(() => mountDecision.seedData?.cronTasks ?? []);
    const [tasks, setTasks] = useState<Task[]>(() => mountDecision.seedData?.tasks ?? []);
    const [backgroundSessionIds, setBackgroundSessionIds] = useState<string[]>(() => mountDecision.seedData?.backgroundSessionIds ?? []);
    const [agentStatuses, setAgentStatuses] = useState<AgentStatusMap>(() => mountDecision.seedData?.agentStatuses ?? {});
    const [agents, setAgents] = useState<AgentConfig[]>(() => mountDecision.seedData?.agents ?? []);
    const [isLoading, setIsLoading] = useState(mountDecision.initialLoading);
    const [error, setError] = useState<string | null>(null);
    const isMountedRef = useRef(true);
    const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const sessionRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const agentRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const cronRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const backgroundRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const lastFetchedAtRef = useRef<Partial<Record<TaskCenterRefreshScope, number>>>({});
    const requestSeqRef = useRef(0);
    const latestRequestSeqByScopeRef = useRef<Partial<Record<TaskCenterRefreshScope, number>>>({});
    const deletedSessionIdsRef = useRef<Set<string>>(new Set());

    const markFetched = useCallback((scope: TaskCenterRefreshScope) => {
        const now = Date.now();
        lastFetchedAtRef.current[scope] = now;
        if (scope === 'all') {
            lastFetchedAtRef.current.sessions = now;
            lastFetchedAtRef.current.cronTasks = now;
            lastFetchedAtRef.current.tasks = now;
            lastFetchedAtRef.current.backgroundSessions = now;
            lastFetchedAtRef.current.agentStatuses = now;
        }
    }, []);

    const startRequest = useCallback((scope: TaskCenterRefreshScope) => {
        const requestSeq = ++requestSeqRef.current;
        latestRequestSeqByScopeRef.current[scope] = requestSeq;
        if (scope === 'all') {
            latestRequestSeqByScopeRef.current.sessions = requestSeq;
            latestRequestSeqByScopeRef.current.cronTasks = requestSeq;
            latestRequestSeqByScopeRef.current.tasks = requestSeq;
            latestRequestSeqByScopeRef.current.backgroundSessions = requestSeq;
            latestRequestSeqByScopeRef.current.agentStatuses = requestSeq;
        }
        return requestSeq;
    }, []);

    const isLatestRequest = useCallback((scope: TaskCenterRefreshScope, requestSeq: number) => {
        return latestRequestSeqByScopeRef.current[scope] === requestSeq;
    }, []);

    const filterDeletedSessions = useCallback((data: SessionMetadata[]) => {
        // Filter both this instance's pending deletes AND the shared module-level
        // tombstones (a session deleted in a sibling Launcher tab), so a transient
        // backend re-return cannot resurrect it here or in the module cache.
        const instance = deletedSessionIdsRef.current;
        return data.filter(session => !instance.has(session.id) && !isSessionDeleted(session.id));
    }, []);

    const fetchData = useCallback(async (retryCount = 0, silent = false) => {
        const requestSeq = startRequest('all');
        if (retryCount === 0 && !silent) setIsLoading(true);
        if (!silent) setError(null);

        try {
            // Track swallowed per-source failures. A PARTIAL failure (e.g. cron
            // load fails while sessions succeed) must NOT be written to the cache
            // as if it were real empty data — that would seed an empty section
            // into the next tab and the fresh-window would skip revalidation.
            // (getSessions has no fallback: it rejects → outer catch → no write.)
            let degraded = false;
            const agentStatusPromise = isTauriEnvironment()
                ? import('@tauri-apps/api/core')
                    .then(({ invoke }) => invoke<AgentStatusMap>('cmd_all_agents_status'))
                    .catch(() => { degraded = true; return {} as AgentStatusMap; })
                : Promise.resolve({} as AgentStatusMap);

            const [sessionsData, cronData, newTasks, bgSessions, agentStatusResult, appConfig] = await Promise.all([
                getSessions(),
                getAllCronTasks().catch(() => { degraded = true; return [] as CronTask[]; }),
                safeTaskList(),
                getBackgroundSessions().catch(() => { degraded = true; return [] as string[]; }),
                agentStatusPromise,
                loadAppConfig().catch(() => { degraded = true; return null; }),
            ]);

            if (!isMountedRef.current) return;

            const displaySessions = sortSessionsByLastActive(filterDeletedSessions(sessionsData));
            const fetchedAgents = appConfig?.agents ?? [];
            if (isLatestRequest('sessions', requestSeq)) setSessions(displaySessions);
            if (isLatestRequest('cronTasks', requestSeq)) setCronTasks(cronData);
            if (isLatestRequest('tasks', requestSeq)) setTasks(newTasks);
            if (isLatestRequest('backgroundSessions', requestSeq)) setBackgroundSessionIds(bgSessions);
            if (isLatestRequest('agentStatuses', requestSeq)) setAgentStatuses(agentStatusResult);
            setAgents(fetchedAgents);
            markFetched('all');
            setError(null);
            perfMark('taskcenter:data-ready');

            // The SINGLE cache-write site (there is no write-back effect). Only a
            // complete, current full-fetch snapshot is cached: skip on any
            // swallowed failure (`degraded`) and on a superseded request. A
            // cache-hit mount that skips revalidation never reaches here, so it
            // can never re-stamp the freshness window (no stale-forever loop).
            if (!degraded && isLatestRequest('all', requestSeq)) {
                writeTaskCenterCache(
                    {
                        sessions: displaySessions,
                        cronTasks: cronData,
                        tasks: newTasks,
                        backgroundSessionIds: bgSessions,
                        agentStatuses: agentStatusResult,
                        agents: fetchedAgents,
                    },
                    Date.now(),
                );
            }
        } catch (err) {
            if (!isMountedRef.current) return;
            console.error('[useTaskCenterData] Failed to load data:', err);
            if (!silent && retryCount < MAX_AUTO_RETRIES) {
                retryTimeoutRef.current = setTimeout(() => {
                    void fetchData(retryCount + 1, silent);
                }, RETRY_DELAY_MS);
            } else if (!silent) {
                setError('加载失败，请稍后重试');
            }
        } finally {
            if (isMountedRef.current && !silent) setIsLoading(false);
        }
    }, [filterDeletedSessions, isLatestRequest, markFetched, startRequest]);

    const refreshSessionsNow = useCallback(() => {
        const requestSeq = startRequest('sessions');
        getSessions().then(data => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('sessions', requestSeq)) return;
            setSessions(sortSessionsByLastActive(filterDeletedSessions(data)));
            markFetched('sessions');
        }).catch(err => {
            console.warn('[useTaskCenterData] Failed to refresh sessions:', err);
        });
    }, [filterDeletedSessions, isLatestRequest, markFetched, startRequest]);

    const refreshCronTasksNow = useCallback(() => {
        const requestSeq = startRequest('cronTasks');
        getAllCronTasks().then(tasks => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('cronTasks', requestSeq)) return;
            setCronTasks(tasks);
            markFetched('cronTasks');
        }).catch(err => {
            console.warn('[useTaskCenterData] Failed to refresh cron tasks:', err);
        });
    }, [isLatestRequest, markFetched, startRequest]);

    const refreshTasksNow = useCallback(() => {
        const requestSeq = startRequest('tasks');
        void safeTaskList().then(newTasks => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('tasks', requestSeq)) return;
            setTasks(newTasks);
            markFetched('tasks');
        });
    }, [isLatestRequest, markFetched, startRequest]);

    const refreshBackgroundSessionsNow = useCallback(() => {
        const requestSeq = startRequest('backgroundSessions');
        getBackgroundSessions().then(ids => {
            if (!isMountedRef.current) return;
            if (!isLatestRequest('backgroundSessions', requestSeq)) return;
            setBackgroundSessionIds(ids);
            markFetched('backgroundSessions');
        }).catch(err => {
            console.warn('[useTaskCenterData] Failed to refresh background sessions:', err);
        });
    }, [isLatestRequest, markFetched, startRequest]);

    const refreshAgentStatusNow = useCallback(() => {
        const requestSeq = startRequest('agentStatuses');
        if (!isTauriEnvironment()) return;
        import('@tauri-apps/api/core')
            .then(({ invoke }) => {
                invoke<AgentStatusMap>('cmd_all_agents_status')
                    .then(statuses => {
                        if (!isMountedRef.current) return;
                        if (!isLatestRequest('agentStatuses', requestSeq)) return;
                        setAgentStatuses(statuses);
                        markFetched('agentStatuses');
                    })
                    .catch(err => {
                        console.warn('[useTaskCenterData] Failed to refresh agent statuses:', err);
                    });
            })
            .catch(err => {
                console.warn('[useTaskCenterData] Failed to load Tauri API for agent statuses:', err);
            });
    }, [isLatestRequest, markFetched, startRequest]);

    // Debounced session refresh (avoids API flooding on rapid events)
    const refreshSessionsDebounced = useCallback((delayMs = 500) => {
        if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
        sessionRefreshTimerRef.current = setTimeout(() => {
            sessionRefreshTimerRef.current = null;
            refreshSessionsNow();
        }, delayMs);
    }, [refreshSessionsNow]);

    const refreshCronTasksDebounced = useCallback((delayMs = 500) => {
        if (cronRefreshTimerRef.current) clearTimeout(cronRefreshTimerRef.current);
        cronRefreshTimerRef.current = setTimeout(() => {
            cronRefreshTimerRef.current = null;
            refreshCronTasksNow();
        }, delayMs);
    }, [refreshCronTasksNow]);

    const tasksRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
    const refreshTasksDebounced = useCallback((delayMs = 500) => {
        if (tasksRefreshTimerRef.current) clearTimeout(tasksRefreshTimerRef.current);
        tasksRefreshTimerRef.current = setTimeout(() => {
            tasksRefreshTimerRef.current = null;
            refreshTasksNow();
        }, delayMs);
    }, [refreshTasksNow]);

    const refreshBackgroundSessionsDebounced = useCallback((delayMs = 500) => {
        if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        backgroundRefreshTimerRef.current = setTimeout(() => {
            backgroundRefreshTimerRef.current = null;
            refreshBackgroundSessionsNow();
        }, delayMs);
    }, [refreshBackgroundSessionsNow]);

    // Debounced Agent status refresh
    const refreshAgentStatusDebounced = useCallback((delayMs = 1000) => {
        if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
        agentRefreshTimerRef.current = setTimeout(() => {
            agentRefreshTimerRef.current = null;
            refreshAgentStatusNow();
        }, delayMs);
    }, [refreshAgentStatusNow]);

    // Initial fetch — SWR: on a cache hit the state is already seeded, so any
    // fetch here is a background revalidate (silent); a fresh cache skips it
    // entirely (rapid tab opening). A cache miss does the loud first load.
    useEffect(() => {
        isMountedRef.current = true;
        perfMark(mountDecision.seedData ? 'taskcenter:mount:cache-hit' : 'taskcenter:mount:cache-miss');
        if (mountDecision.revalidate) {
            void fetchData(0, mountDecision.silent);
        }
        return () => {
            isMountedRef.current = false;
            if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
            if (cronRefreshTimerRef.current) clearTimeout(cronRefreshTimerRef.current);
            if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        };
    }, [fetchData, mountDecision]);

    // Refresh on tab activation (inactive → active transition)
    const prevIsActiveRef = useRef(isActive);
    useEffect(() => {
        const wasInactive = !prevIsActiveRef.current;
        prevIsActiveRef.current = isActive;
        if (!wasInactive || !isActive) return;
        void fetchData(0, true);
    }, [isActive, fetchData]);

    // Lightweight fallback: while Launcher is active, reconcile all task-center data once a minute.
    useEffect(() => {
        if (!isActive) return;
        const interval = setInterval(() => {
            void fetchData(0, true);
        }, BACKGROUND_REFRESH_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [isActive, fetchData]);

    // Refresh sessions when a session title changes (auto-generated or user rename)
    useEffect(() => {
        const handler = () => refreshSessionsDebounced(300);
        window.addEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
        return () => window.removeEventListener(CUSTOM_EVENTS.SESSION_TITLE_CHANGED, handler);
    }, [refreshSessionsDebounced]);

    // Event listeners for real-time updates. The previous shape needed a
    // bespoke `register()` helper to handle the post-await unmount race
    // (cross-review W3); `listenWithCleanup` now bakes that pattern in.
    useEffect(() => {
        if (!isTauriEnvironment()) return;
        const ac = new AbortController();

        // Background completion events
        void listenWithCleanup('session:background-complete', () => {
            refreshBackgroundSessionsDebounced();
            refreshSessionsDebounced();
        }, ac.signal);

        // Cron task events
        void listenWithCleanup('cron:task-stopped', () => refreshCronTasksDebounced(), ac.signal);
        void listenWithCleanup('cron:task-started', () => refreshCronTasksDebounced(), ac.signal);
        void listenWithCleanup('cron:execution-complete', () => {
            refreshCronTasksDebounced();
            refreshSessionsDebounced();
        }, ac.signal);

        // Scheduler started (resume / recovery)
        void listenWithCleanup('cron:scheduler-started', () => {
            refreshCronTasksDebounced();
            refreshSessionsDebounced();
        }, ac.signal);

        // Task deleted / updated
        void listenWithCleanup('cron:task-deleted', () => refreshCronTasksDebounced(), ac.signal);
        void listenWithCleanup('cron:task-updated', () => refreshCronTasksDebounced(), ac.signal);

        // Agent status changes (channel started/stopped, session created)
        void listenWithCleanup('agent:status-changed', () => {
            refreshAgentStatusDebounced();
            refreshSessionsDebounced(1000);
        }, ac.signal);

        // New-model Task status changes (dispatch / run / done / delete).
        // Mirrors the cron task listeners so the Launcher 「我的任务」 tab
        // reflects edits made elsewhere (Task Center, CLI, agent self-update)
        // without the user manually refreshing.
        void listenWithCleanup('task:status-changed', () => refreshTasksDebounced(), ac.signal);

        return () => {
            ac.abort();
            if (sessionRefreshTimerRef.current) clearTimeout(sessionRefreshTimerRef.current);
            if (agentRefreshTimerRef.current) clearTimeout(agentRefreshTimerRef.current);
            if (cronRefreshTimerRef.current) clearTimeout(cronRefreshTimerRef.current);
            if (tasksRefreshTimerRef.current) clearTimeout(tasksRefreshTimerRef.current);
            if (backgroundRefreshTimerRef.current) clearTimeout(backgroundRefreshTimerRef.current);
        };
    }, [refreshSessionsDebounced, refreshCronTasksDebounced, refreshTasksDebounced, refreshBackgroundSessionsDebounced, refreshAgentStatusDebounced]);

    // Compute session tags (memoized)
    const sessionTagsMap = useMemo(() => {
        const map = new Map<string, SessionTag[]>();

        // Build IM session map: sessionId → platform display name
        const imSessionPlatformMap = new Map<string, string>();

        // From agent channel statuses
        for (const agentStatus of Object.values(agentStatuses)) {
            for (const channel of agentStatus.channels) {
                if (channel.status !== 'online' && channel.status !== 'connecting') continue;
                for (const activeSession of (channel.activeSessions as { sessionKey: string; sessionId: string }[])) {
                    imSessionPlatformMap.set(activeSession.sessionId, extractPlatformDisplay(activeSession.sessionKey));
                }
            }
        }

        // Build running cron task session sets.
        // Use internalSessionId (actual SDK session) when available, falling back to sessionId.
        // One-shot ('at' kind) tasks are routed into the background set instead of the cron set —
        // the unified-primitive architecture uses CronTask for all executions, but a one-off
        // execution is semantically a background task, not a scheduled task.
        const cronSessionIds = new Set<string>();
        const bgSessionIds = new Set<string>(backgroundSessionIds);
        for (const t of cronTasks) {
            if (t.status !== 'running') continue;
            const sid = t.internalSessionId || t.sessionId;
            if (t.schedule?.kind === 'at') {
                bgSessionIds.add(sid);
            } else {
                cronSessionIds.add(sid);
            }
        }

        // Assign tags to each session
        for (const session of sessions) {
            const tags: SessionTag[] = [];
            const imPlatform = imSessionPlatformMap.get(session.id);
            if (imPlatform) tags.push({ type: 'im', platform: imPlatform });
            if (cronSessionIds.has(session.id)) tags.push({ type: 'cron' });
            if (bgSessionIds.has(session.id)) tags.push({ type: 'background' });
            if (tags.length > 0) map.set(session.id, tags);
        }

        return map;
    }, [sessions, cronTasks, backgroundSessionIds, agentStatuses]);

    // Compute cron bot info map from agents[].channels[] (memoized)
    const cronBotInfoMap = useMemo(() => {
        const map = new Map<string, { name: string; platform: string }>();
        for (const agent of agents) {
            for (const channel of (agent.channels ?? [])) {
                map.set(channel.id, {
                    name: channel.name || agent.name,
                    platform: channel.type,
                });
            }
        }
        return map;
    }, [agents]);

    const refresh = useCallback((scope: TaskCenterRefreshScope = 'all', options: TaskCenterRefreshOptions = {}) => {
        if (!options.force && options.minIntervalMs) {
            const lastFetchedAt = lastFetchedAtRef.current[scope] ?? 0;
            if (Date.now() - lastFetchedAt < options.minIntervalMs) return;
        }
        if (scope === 'sessions') {
            refreshSessionsNow();
            return;
        }
        if (scope === 'cronTasks') {
            refreshCronTasksNow();
            return;
        }
        if (scope === 'tasks') {
            refreshTasksNow();
            return;
        }
        if (scope === 'backgroundSessions') {
            refreshBackgroundSessionsNow();
            return;
        }
        if (scope === 'agentStatuses') {
            refreshAgentStatusNow();
            return;
        }
        void fetchData(0, options.silent ?? false);
    }, [fetchData, refreshAgentStatusNow, refreshBackgroundSessionsNow, refreshCronTasksNow, refreshTasksNow, refreshSessionsNow]);

    const actions = useMemo<TaskCenterActions>(() => ({
        deleteSession: async (sessionId: string) => {
            const success = await deleteSessionApi(sessionId);
            if (!success) return false;

            deletedSessionIdsRef.current.add(sessionId);
            markSessionDeleted(sessionId); // shared tombstone — survives into the module cache + sibling tabs
            setSessions(prev => prev.filter(s => s.id !== sessionId));

            try {
                await deactivateSession(sessionId);
            } catch (err) {
                console.warn('[useTaskCenterData] Failed to deactivate deleted session:', err);
            }

            refresh('sessions', { force: true, reason: 'delete-session', silent: true });
            return true;
        },
        refreshSessions: () => refresh('sessions', { force: true, silent: true }),
        refreshCronTasks: () => refresh('cronTasks', { force: true, silent: true }),
        refreshTasks: () => refresh('tasks', { force: true, silent: true }),
    }), [refresh]);

    return {
        sessions,
        cronTasks,
        tasks,
        sessionTagsMap,
        cronBotInfoMap,
        isLoading,
        error,
        refresh,
        actions,
    };
}
