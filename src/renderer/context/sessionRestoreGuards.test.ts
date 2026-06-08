import { describe, it, expect } from 'vitest';
import {
    isRestoredSession,
    shouldSkipHistoryReplay,
    shouldClearHistoryOnInit,
} from './sessionRestoreGuards';

const SID = 'e959f73c-42af-4fb6-9c50-4b9c589ee975';
const OTHER = '11111111-2222-3333-4444-555555555555';

describe('isRestoredSession', () => {
    it('matches only when both ids are non-null and equal', () => {
        expect(isRestoredSession(SID, SID)).toBe(true);
        expect(isRestoredSession(SID, OTHER)).toBe(false);
        expect(isRestoredSession(null, SID)).toBe(false);
        expect(isRestoredSession(SID, null)).toBe(false);
        // Two nulls must NOT be a match — that is the first-ever / no-session state.
        expect(isRestoredSession(null, null)).toBe(false);
    });
});

describe('shouldSkipHistoryReplay', () => {
    it('skips COLD-HISTORY replay once the session is REST-restored (the #0608 fix)', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                restoredSessionId: SID,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });

    it('does NOT skip a LIVE echo (freshly-sent user bubble) on a REST-restored session', () => {
        // #0608 Codex-review blocker: chat:message-replay is overloaded — a newly
        // sent user/command bubble echoes on the SAME event with no replayKind. It
        // is the authoritative render path for the bubble and MUST NOT be suppressed,
        // else new messages vanish from the UI after a restore.
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: false,
                restoredSessionId: SID,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('does NOT skip cold-history for a session that was never REST-restored (SSE-only)', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('does NOT skip cold-history when a different session was restored', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: false,
                isColdHistoryReplay: true,
                restoredSessionId: OTHER,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('skips ANY replay while loadSession REST fetch is in flight', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: false,
                isLoadingSession: true,
                isColdHistoryReplay: false,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });

    it('skips ANY replay while a new session is being born', () => {
        expect(
            shouldSkipHistoryReplay({
                isNewSession: true,
                isLoadingSession: false,
                isColdHistoryReplay: false,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });
});

describe('shouldClearHistoryOnInit', () => {
    it('does NOT clear a REST-restored session even if the history ref still reads 0', () => {
        // The exact #0608 race: loadSession just set the page, but historyMessagesRef
        // (commit-lagging mirror) momentarily reports 0 when a late chat:init arrives.
        // The REST-restored guard must keep the page on screen.
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 0,
                restoredSessionId: SID,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('clears on first-ever chat:init with no session and no history (legit no-op clear)', () => {
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 0,
                restoredSessionId: null,
                currentSessionId: null,
            }),
        ).toBe(true);
    });

    it('does NOT clear while loadSession is in flight', () => {
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: true,
                historyLength: 0,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('does NOT clear when history is already on screen', () => {
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 80,
                restoredSessionId: null,
                currentSessionId: SID,
            }),
        ).toBe(false);
    });

    it('clears a backend-initiated auto-reset that emptied a non-restored session', () => {
        // chat:init for a session that was reset backend-side (not REST-restored,
        // nothing on screen) is the one case the clear is still correct.
        expect(
            shouldClearHistoryOnInit({
                isLoadingSession: false,
                historyLength: 0,
                restoredSessionId: OTHER,
                currentSessionId: SID,
            }),
        ).toBe(true);
    });
});
