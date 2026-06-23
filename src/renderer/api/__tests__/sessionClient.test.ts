import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    apiFetch: vi.fn(),
    apiGetJson: vi.fn(),
    apiPostJson: vi.fn(),
    deactivateSession: vi.fn(),
    hasSessionSidecarOrThrow: vi.fn(),
    isTauri: vi.fn(),
}));

vi.mock('../apiFetch', () => ({
    apiFetch: mocks.apiFetch,
    apiGetJson: mocks.apiGetJson,
    apiPostJson: mocks.apiPostJson,
}));

vi.mock('../tauriClient', () => ({
    deactivateSession: mocks.deactivateSession,
    hasSessionSidecarOrThrow: mocks.hasSessionSidecarOrThrow,
    isTauri: mocks.isTauri,
}));

import { deleteSession } from '../sessionClient';

const okResponse = () => new Response(JSON.stringify({ success: true }), { status: 200 });
const notFoundResponse = () => new Response(JSON.stringify({ success: false }), { status: 404 });

describe('deleteSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.isTauri.mockReturnValue(true);
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(false);
        mocks.deactivateSession.mockResolvedValue(undefined);
        mocks.apiFetch.mockResolvedValue(okResponse());
    });

    it('deletes storage only after confirming the session has no live sidecar', async () => {
        await expect(deleteSession('session-1')).resolves.toBe(true);

        expect(mocks.hasSessionSidecarOrThrow).toHaveBeenCalledWith('session-1');
        expect(mocks.apiFetch).toHaveBeenCalledWith('/sessions/session-1', { method: 'DELETE' });
        expect(mocks.deactivateSession).toHaveBeenCalledWith('session-1');
        expect(mocks.hasSessionSidecarOrThrow.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.apiFetch.mock.invocationCallOrder[0],
        );
    });

    it('refuses to delete storage while any sidecar owner is still alive', async () => {
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(true);

        await expect(deleteSession('session-live')).resolves.toBe(false);

        expect(mocks.apiFetch).not.toHaveBeenCalled();
        expect(mocks.deactivateSession).not.toHaveBeenCalled();
    });

    it('does not release any owner as a side effect of storage deletion', async () => {
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(true);

        await expect(deleteSession('session-owned')).resolves.toBe(false);

        expect(mocks.apiFetch).not.toHaveBeenCalled();
    });

    it('keeps browser development mode deletion working without Rust sidecar checks', async () => {
        mocks.isTauri.mockReturnValue(false);
        mocks.hasSessionSidecarOrThrow.mockResolvedValue(true);

        await expect(deleteSession('session-browser')).resolves.toBe(true);

        expect(mocks.hasSessionSidecarOrThrow).not.toHaveBeenCalled();
        expect(mocks.apiFetch).toHaveBeenCalledWith('/sessions/session-browser', { method: 'DELETE' });
    });

    it('fails closed when sidecar presence cannot be verified', async () => {
        mocks.hasSessionSidecarOrThrow.mockRejectedValue(new Error('ipc unavailable'));

        await expect(deleteSession('session-unknown')).resolves.toBe(false);

        expect(mocks.apiFetch).not.toHaveBeenCalled();
        expect(mocks.deactivateSession).not.toHaveBeenCalled();
    });

    it('returns false when the delete endpoint rejects the deletion', async () => {
        mocks.apiFetch.mockResolvedValue(notFoundResponse());

        await expect(deleteSession('missing-session')).resolves.toBe(false);

        expect(mocks.deactivateSession).not.toHaveBeenCalled();
    });
});
