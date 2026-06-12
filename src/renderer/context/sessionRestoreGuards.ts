// Pure decision core for coordinating the two history-restore paths in
// TabProvider, extracted so the invariants are unit-testable (Functional Core /
// Imperative Shell). See sessionRestoreGuards.test.ts.
//
// Background (#0608 — "restore drops recent messages"):
//   A chat tab restores history through TWO paths that must not fight:
//     1. REST `/sessions/:id` — reads DISK (authoritative, paginated, ordered).
//        loadSession sets the full first page, then marks the session as
//        REST-restored (`restoredSessionId`).
//     2. SSE `/chat/stream` — on connect sends `chat:init` then replays the
//        sidecar's IN-MEMORY history as `chat:message-replay` events.
//   When both ran for the same session, a late `chat:init` (arriving in the
//   commit window right after loadSession dropped its load guard) wiped the
//   just-restored REST page, and the in-memory replay then refilled it with an
//   older / truncated set — the user's most recent messages disappeared.
//
//   Fix: REST is the single source of truth for history. Once a session is
//   REST-restored, SSE `chat:init` must not clear it and `chat:message-replay`
//   must not re-deliver history (older pages come via `?before=`; the in-flight
//   turn rides REST's liveStreamingMessage + live chunk events). These two pure
//   predicates encode that coordination.

/**
 * True iff history for `currentSessionId` was already authoritatively restored
 * from disk by loadSession. BOTH ids must be non-null AND equal — a null
 * `restoredSessionId` means "never REST-restored", and two nulls must NOT be
 * treated as a match (that would mis-handle the first-ever, no-session state).
 */
export function isRestoredSession(
    restoredSessionId: string | null,
    currentSessionId: string | null,
): boolean {
    return restoredSessionId !== null && restoredSessionId === currentSessionId;
}

/**
 * Whether an SSE `chat:message-replay` event should be skipped.
 *
 * `chat:message-replay` is OVERLOADED (Codex review of #0608): the SSE-connect
 * backfill replays the whole in-memory transcript with `replayKind:
 * 'cold-history'`, but the SAME event also carries LIVE echoes of a freshly-sent
 * user / command bubble (no `replayKind`). Only the cold-history backfill yields
 * to a REST-restored session — REST owns the ordered, paginated history, and
 * re-delivering the in-memory set on top of a partial REST page reorders /
 * truncates it. A LIVE echo must ALWAYS render, otherwise a new user message
 * sent after a restore disappears from the UI while the assistant streams.
 *
 * Reset-session birth has one extra transient: `/chat/reset` can synchronize
 * the renderer/Rust to the freshly minted backend id before the later
 * `chat:system-init` confirms it. During that window, cold-history replay must
 * still stay out of the empty new tab, but live echoes must render.
 */
export function shouldSkipHistoryReplay(p: {
    isNewSession: boolean;
    isLoadingSession: boolean;
    isColdHistoryReplay: boolean;
    isResetBirthPending?: boolean;
    restoredSessionId: string | null;
    currentSessionId: string | null;
}): boolean {
    if (p.isNewSession || p.isLoadingSession) return true;
    if (p.isColdHistoryReplay && p.isResetBirthPending) return true;
    return (
        p.isColdHistoryReplay &&
        isRestoredSession(p.restoredSessionId, p.currentSessionId)
    );
}

/**
 * Whether an SSE `chat:init` should clear local history. Only when no load is in
 * flight, nothing is on screen yet, AND the session hasn't been REST-restored.
 * The REST-restored check is the load-bearing guard: it stays correct even when
 * `historyLength` (read from a commit-lagging ref mirror) momentarily reports 0
 * right after loadSession set the page — preventing the #0608 wipe.
 */
export function shouldClearHistoryOnInit(p: {
    isLoadingSession: boolean;
    historyLength: number;
    restoredSessionId: string | null;
    currentSessionId: string | null;
}): boolean {
    return (
        !p.isLoadingSession &&
        p.historyLength === 0 &&
        !isRestoredSession(p.restoredSessionId, p.currentSessionId)
    );
}
