import { describe, expect, it } from 'vitest';

import { buildChatFlipPatch, createNewTab, type Tab } from './tab';

describe('buildChatFlipPatch — chat-flip invariants (instant-nav D1)', () => {
    const base: Tab = { ...createNewTab(), id: 'tab-1' };

    it('flips view to chat and always carries a truthy sessionId (D1)', () => {
        const patch = buildChatFlipPatch(base, {
            agentDir: '/ws/a',
            sessionId: 'pending-tab-1',
            title: 'A',
        });
        expect(patch.view).toBe('chat');
        expect(patch.sessionId).toBe('pending-tab-1');
        expect(patch.sessionId).toBeTruthy(); // D1: never null → SSE connect effect fires
        expect(patch.agentDir).toBe('/ws/a');
        expect(patch.title).toBe('A');
    });

    it('preserves unrelated tab fields (id, isGenerating, hasUnread)', () => {
        const patch = buildChatFlipPatch(
            { ...base, isGenerating: true, hasUnread: true },
            { agentDir: '/ws/a', sessionId: 's1', title: 'A' },
        );
        expect(patch.id).toBe('tab-1');
        expect(patch.isGenerating).toBe(true);
        expect(patch.hasUnread).toBe(true);
    });

    it('omits initialMessage when not provided (no undefined clobber)', () => {
        const patch = buildChatFlipPatch(
            { ...base, initialMessage: { text: 'keep' } },
            { agentDir: '/ws/a', sessionId: 's1', title: 'A' },
        );
        // Not provided → the key is not written, so a prior value survives.
        expect(patch.initialMessage).toEqual({ text: 'keep' });
    });

    it('attaches initialMessage when provided', () => {
        const patch = buildChatFlipPatch(base, {
            agentDir: '/ws/a',
            sessionId: 's1',
            title: 'A',
            initialMessage: { text: 'hi' },
        });
        expect(patch.initialMessage).toEqual({ text: 'hi' });
    });

    it('includes joinedExistingSidecar only when explicitly provided', () => {
        const withFlag = buildChatFlipPatch(base, { agentDir: '/ws/a', sessionId: 's1', title: 'A', joinedExistingSidecar: true });
        expect(withFlag.joinedExistingSidecar).toBe(true);
        const without = buildChatFlipPatch(base, { agentDir: '/ws/a', sessionId: 's1', title: 'A' });
        expect('joinedExistingSidecar' in without).toBe(false);
    });
});
