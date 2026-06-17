/**
 * Pure guard for session-scoped SSE snapshots.
 *
 * A Tab can switch from session A to a pending session B while A's SSE
 * connection is still draining cached/live events. Snapshot-style events must
 * only update state when they came through the SSE connection currently bound
 * to this tab's session.
 *
 * The one valid mismatch is a new-session birth: the SSE stream may still be
 * labelled with the tab's pending id while the SDK snapshot already carries
 * the newly minted concrete session id. Payload session ids make that upgrade
 * window explicit; every other connected/current mismatch is stale.
 */
export function shouldAcceptSessionScopedSseSnapshot(p: {
    connectedSessionId: string | null;
    currentSessionId: string | null;
    payloadSessionId?: string | null;
    isConnectedSessionPending: boolean;
    isCurrentSessionPending: boolean;
}): boolean {
    const isBootstrappingCurrentSession =
        p.connectedSessionId === null &&
        p.currentSessionId !== null &&
        !p.isCurrentSessionPending &&
        p.payloadSessionId === p.currentSessionId;

    const isSameAttachedSession =
        isBootstrappingCurrentSession ||
        p.connectedSessionId === p.currentSessionId ||
        (
            p.isConnectedSessionPending &&
            !p.isCurrentSessionPending &&
            p.payloadSessionId === p.currentSessionId
        );

    if (!isSameAttachedSession) {
        return false;
    }

    if (
        p.payloadSessionId &&
        p.currentSessionId &&
        !p.isCurrentSessionPending &&
        p.payloadSessionId !== p.currentSessionId
    ) {
        return false;
    }

    return true;
}

/**
 * Session-scoped snapshots are normally cleared whenever the session prop
 * changes. Preserve them only when the component has already adopted the
 * concrete session id internally, and the parent prop is merely catching up
 * from the pending placeholder for the same just-born session.
 */
export function shouldPreserveSnapshotOnPendingBirthPropSync(p: {
    previousSessionId: string | null;
    nextSessionId: string | null;
    currentSessionIdBeforeSync: string | null;
    wasPreviousSessionPending: boolean;
    isNextSessionPending: boolean;
}): boolean {
    return (
        p.previousSessionId !== null &&
        p.nextSessionId !== null &&
        p.wasPreviousSessionPending &&
        !p.isNextSessionPending &&
        p.currentSessionIdBeforeSync === p.nextSessionId
    );
}

export type PersistedContextUsageSeedDecision = 'seed' | 'clear' | 'preserve-live';

export function decidePersistedContextUsageSeed(p: {
    snapshotSource: string | null | undefined;
    seedRuntime: string;
    targetSessionId: string;
    liveSessionId: string | null;
}): PersistedContextUsageSeedDecision {
    if (p.liveSessionId === p.targetSessionId) {
        return 'preserve-live';
    }
    return p.snapshotSource === p.seedRuntime ? 'seed' : 'clear';
}
