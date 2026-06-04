/**
 * Frontend API client for Session management
 */

import { apiFetch, apiGetJson, apiPostJson } from './apiFetch';

export interface SessionStats {
    messageCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens?: number;
    totalCacheCreationTokens?: number;
}

export interface MessageUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    model?: string;
}

export interface SessionMetadata {
    id: string;
    agentDir: string;
    title: string;
    createdAt: string;
    lastActiveAt: string;
    /** @deprecated legacy split-id sessions; equals id on unified sessions */
    sdkSessionId?: string;
    unifiedSession?: boolean;
    stats?: SessionStats;
    /** Associated cron task ID (if this session is used by a scheduled task) */
    cronTaskId?: string;
    /**
     * Session origin — `'desktop'` for desktop, `'{platform}_private'` / `'{platform}_group'`
     * for IM channels. Platform segment is open-ended because OpenClaw plugins register
     * dynamic platform names at runtime (e.g. `'weixin_private'`, `'qq_group'`). Treat as
     * an opaque string; use `isImSource()` for categorization.
     */
    source?: string;
    /** User-pinned to the 收藏 filter view. Only `true` is persisted; absent
     *  has identical meaning to false. */
    favorite?: boolean;
    /** Preview of the last user message (truncated, for Task Center display) */
    lastMessagePreview?: string;
    /** How the title was set: default (first message truncation), auto (AI-generated), user (manually renamed) */
    titleSource?: 'default' | 'auto' | 'user';
    /** Fork source — present on first open after a fork, consumed and cleared */
    forkFrom?: { sourceSessionId: string; messageUuid?: string };
    /** Runtime that created this session. Absent = pre-v0.1.60 session → treat as 'builtin' */
    runtime?: string;
    /** Runtime's native session/thread ID (Codex threadId, CC session_id from hook) */
    runtimeSessionId?: string;

    // ─── Config snapshot (v0.1.69) ───
    // Desktop/Cron sessions capture these on first write; IM sessions stay undefined
    // (live-follow AgentConfig). `configSnapshotAt` presence marks "locked".
    model?: string;
    permissionMode?: string;
    mcpEnabledServers?: string[];
    providerId?: string;
    /** Credentials — server redacts to '[redacted]' in PATCH response (zero-trust) */
    providerEnvJson?: string;
    configSnapshotAt?: string;
}

export interface SessionMessage {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    usage?: MessageUsage;
    toolCount?: number;
    durationMs?: number;
}

export interface SessionData extends SessionMetadata {
    messages: SessionMessage[];
}

export interface SessionDetailedStats {
    summary: SessionStats;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
    }>;
    messageDetails: Array<{
        userQuery: string;
        model?: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
        toolCount?: number;
        durationMs?: number;
    }>;
}

/**
 * Get all sessions, optionally filtered by agentDir
 */
export async function getSessions(agentDir?: string): Promise<SessionMetadata[]> {
    const endpoint = agentDir
        ? `/sessions?agentDir=${encodeURIComponent(agentDir)}`
        : '/sessions';
    const result = await apiGetJson<{ success: boolean; sessions: SessionMetadata[] }>(endpoint);
    return result.sessions ?? [];
}

/**
 * Create a new session
 */
export async function createSession(agentDir: string, runtime?: string): Promise<SessionMetadata> {
    const result = await apiPostJson<{ success: boolean; session: SessionMetadata }>(
        '/sessions',
        { agentDir, ...(runtime ? { runtime } : {}) }
    );
    return result.session;
}

/**
 * Get session details with messages
 */
export async function getSessionDetails(sessionId: string): Promise<SessionData | null> {
    try {
        const result = await apiGetJson<{ success: boolean; session: SessionData }>(
            `/sessions/${sessionId}`
        );
        return result.session ?? null;
    } catch {
        return null;
    }
}

/**
 * Delete a session
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
    try {
        await apiFetch(`/sessions/${sessionId}`, { method: 'DELETE' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Update session metadata
 */
export async function updateSession(
    sessionId: string,
    updates: {
        title?: string;
        titleSource?: 'default' | 'auto' | 'user';
        /** true → pin to 收藏 view; false → unpin. Server only stores `true`,
         *  so toggling off shrinks the on-disk metadata back to the absent
         *  baseline. */
        favorite?: boolean;
        // v0.1.69 snapshot fields — null clears, undefined leaves unchanged.
        // Server auto-stamps configSnapshotAt when any snapshot field is touched
        // and redacts providerEnvJson to '[redacted]' in the response (zero-trust).
        model?: string | null;
        permissionMode?: string | null;
        mcpEnabledServers?: string[] | null;
        providerId?: string | null;
        providerEnvJson?: string | null;
    }
): Promise<SessionMetadata | null> {
    // #305: throw on HTTP / JSON failure instead of returning null.
    // Pre-fix: catch-all → null → callers treated persistence failures as
    // "session not found" silently, and `persistInputOptionChange` swallowed
    // them as success. Now `patchSnapshot` rejects on real failure so the
    // toast warning "配置未能完全保存" actually fires for the user.
    const result = await apiFetch(`/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    if (!result.ok) {
        // 404 ("Session not found") is the one legitimate null — race where
        // the session was deleted out from under us. Other status codes are
        // real failures the caller needs to know about.
        if (result.status === 404) return null;
        const body = await result.text().catch(() => '');
        throw new Error(`PATCH /sessions/${sessionId} failed: HTTP ${result.status} ${body.slice(0, 200)}`);
    }
    const data = await result.json() as { success: boolean; session: SessionMetadata };
    return data.session ?? null;
}

/**
 * Get detailed session statistics
 */
export async function getSessionStats(sessionId: string): Promise<SessionDetailedStats | null> {
    try {
        const result = await apiGetJson<{ success: boolean; stats: SessionDetailedStats }>(
            `/sessions/${sessionId}/stats`
        );
        return result.stats ?? null;
    } catch {
        return null;
    }
}

// Auto session-title generation moved fully to the backend Title Service (#296):
// the sidecar triggers it after a successful turn and pushes the result via the
// `chat:session-title-changed` SSE event. The former `generateSessionTitle`
// client helper + its frontend trigger in TabProvider were retired. The
// `/api/generate-session-title` endpoint still exists for a future manual
// "regenerate title" action.

// ============= Global Stats =============

export interface GlobalStats {
    summary: {
        totalSessions: number;
        messageCount: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        totalCacheReadTokens: number;
        totalCacheCreationTokens: number;
    };
    daily: Array<{
        date: string;
        inputTokens: number;
        outputTokens: number;
        messageCount: number;
    }>;
    byModel: Record<string, {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        count: number;
    }>;
}

/**
 * Get global token usage statistics
 */
export async function getGlobalStats(range: '7d' | '30d' | '60d'): Promise<GlobalStats | null> {
    try {
        const result = await apiGetJson<{ success: boolean; stats: GlobalStats }>(
            `/api/global-stats?range=${range}`
        );
        return result.stats ?? null;
    } catch {
        return null;
    }
}
