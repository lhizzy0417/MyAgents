/**
 * Issue #336 — deleteSession vs live-sidecar persist race.
 *
 * Artifact state in the wild: a session's sessions.json entry is GONE while its
 * full JSONL sits on disk (10MB / 221 messages in the report). Root cause:
 * deleteSession removes the index entry + unlinks the JSONL, but a live sidecar
 * still holding the session in memory persists afterwards — saveSessionMessages
 * saw existsSync=false → existingCount=0 → re-appended the ENTIRE in-memory
 * array, resurrecting the file as an invisible orphan no UI can reach.
 *
 * The fix enforces the index⟺data invariant at the single point that creates
 * JSONL files: saveSessionMessages refuses a WOULD-CREATE write when the session
 * has no sessions.json entry. Appends to an EXISTING unindexed file stay allowed
 * (legacy orphans keep accumulating their data rather than losing it).
 *
 * HOME is redirected to a temp dir BEFORE a fresh (vi.resetModules) dynamic
 * import of SessionStore, so the module-level ~/.myagents paths bind to the
 * sandbox. A guard test asserts the binding before anything destructive runs.
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type SessionStoreModule = typeof import('../SessionStore');

let home: string;
let store: SessionStoreModule;
let originalHome: string | undefined;

const sessionsDir = () => join(home, '.myagents', 'sessions');
const sessionsJson = () => join(home, '.myagents', 'sessions.json');
const jsonlPath = (id: string) => join(sessionsDir(), `${id}.jsonl`);

function msg(id: number) {
    return {
        id: String(id),
        role: 'user' as const,
        content: `message ${id}`,
        timestamp: new Date().toISOString(),
    };
}

beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'myagents-336-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    vi.resetModules();
    store = await import('../SessionStore');
});

afterAll(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
});

describe('issue #336 — delete vs persist resurrection', () => {
    it('sandbox guard: SessionStore is bound to the temp HOME', async () => {
        const meta = await store.createSession('/tmp/workspace-a');
        // The entry must land in the sandbox sessions.json — if this fails the
        // module bound to the real home dir and NOTHING below may run.
        expect(existsSync(sessionsJson())).toBe(true);
        const all = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(all.some(s => s.id === meta.id)).toBe(true);
    });

    it('a post-delete persist must NOT resurrect the JSONL (the #336 race)', async () => {
        const meta = await store.createSession('/tmp/workspace-a');
        const history = [msg(0), msg(1)];
        const initialSave = await store.saveSessionMessages(meta.id, history);
        expect(initialSave.ok).toBe(true);
        expect(existsSync(jsonlPath(meta.id))).toBe(true);

        const deleted = await store.deleteSession(meta.id);
        expect(deleted).toBe(true);
        expect(existsSync(jsonlPath(meta.id))).toBe(false);
        expect(store.getSessionMetadata(meta.id)).toBeNull();

        // Simulate the live owner sidecar persisting its in-memory array after
        // the delete (resetSession's "persist before clearing" / turn complete).
        const postDeleteSave = await store.saveSessionMessages(meta.id, [...history, msg(2)]);
        expect(postDeleteSave.ok).toBe(false);
        if (!postDeleteSave.ok) {
            expect(postDeleteSave.reason).toBe('unindexed-create-refused');
        }

        // Old code: the file is re-created with ALL messages (full orphan).
        expect(existsSync(jsonlPath(meta.id))).toBe(false);
        const all = JSON.parse(readFileSync(sessionsJson(), 'utf-8')) as Array<{ id: string }>;
        expect(all.some(s => s.id === meta.id)).toBe(false);
    });

    it('refuses to CREATE a JSONL for a never-registered session id', async () => {
        const ghostId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
        const result = await store.saveSessionMessages(ghostId, [msg(0)]);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('unindexed-create-refused');
        }
        expect(existsSync(jsonlPath(ghostId))).toBe(false);
    });

    it('still appends to an EXISTING unindexed file (legacy orphan keeps its data)', async () => {
        const orphanId = '11111111-2222-3333-4444-555555555555';
        mkdirSync(sessionsDir(), { recursive: true });
        writeFileSync(jsonlPath(orphanId), JSON.stringify(msg(0)) + '\n', 'utf-8');

        const result = await store.saveSessionMessages(orphanId, [msg(0), msg(1)]);
        expect(result.ok).toBe(true);

        const lines = readFileSync(jsonlPath(orphanId), 'utf-8').trim().split('\n');
        expect(lines).toHaveLength(2);
    });

    it('deleteSession returns false for an unknown id', async () => {
        expect(await store.deleteSession('99999999-9999-9999-9999-999999999999')).toBe(false);
    });
});
