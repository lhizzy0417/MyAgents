import { describe, it, expect } from 'vitest';

import { serializeTabs, deserializeTabs } from './tabPersistence';
import { MAX_TABS, type Tab } from '@/types/tab';

function chatTab(over: Partial<Tab> = {}): Tab {
    return {
        id: `tab-${Math.random().toString(36).slice(2, 8)}`,
        agentDir: '/ws/a',
        sessionId: '11111111-2222-3333-4444-555555555555',
        view: 'chat',
        title: 'Chat A',
        ...over,
    };
}

describe('serializeTabs', () => {
    it('keeps only chat tabs with a real session + workspace', () => {
        const tabs: Tab[] = [
            chatTab({ id: 'a', sessionId: 'sid-a' }),
            { id: 'b', agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' },
            { id: 'c', agentDir: null, sessionId: null, view: 'settings', title: 'Settings' },
            { id: 'd', agentDir: '/ws/d', sessionId: null, view: 'taskcenter', title: 'Tasks' },
            chatTab({ id: 'e', sessionId: 'pending-tab-e' }), // pending → dropped
            chatTab({ id: 'f', agentDir: '', sessionId: 'sid-f' }), // no workspace → dropped
        ];
        const state = serializeTabs(tabs, 'a');
        expect(state).not.toBeNull();
        expect(state!.tabs.map((t) => t.id)).toEqual(['a']);
    });

    it('whitelists fields — no runtime-only fields leak to disk', () => {
        const tab = chatTab({
            id: 'a',
            sessionId: 'sid-a',
            isGenerating: true,
            hasUnread: true,
            joinedExistingSidecar: true,
            restoreState: 'cold',
            initialMessage: { text: 'secret draft' },
        });
        const state = serializeTabs([tab], 'a')!;
        expect(state.tabs[0]).toEqual({
            id: 'a',
            agentDir: '/ws/a',
            sessionId: 'sid-a',
            title: 'Chat A',
        });
        expect(Object.keys(state.tabs[0])).not.toContain('isGenerating');
        expect(Object.keys(state.tabs[0])).not.toContain('restoreState');
        expect(Object.keys(state.tabs[0])).not.toContain('initialMessage');
    });

    it('de-dupes by sessionId (first occurrence wins)', () => {
        const tabs = [
            chatTab({ id: 'a', sessionId: 'dup' }),
            chatTab({ id: 'b', sessionId: 'dup' }),
            chatTab({ id: 'c', sessionId: 'other' }),
        ];
        const state = serializeTabs(tabs, 'b')!;
        expect(state.tabs.map((t) => t.id)).toEqual(['a', 'c']);
        // active 'b' was deduped away → falls back to first surviving tab
        expect(state.activeTabId).toBe('a');
    });

    it('preserves activeTabId when it survives filtering', () => {
        const tabs = [chatTab({ id: 'a', sessionId: 's1' }), chatTab({ id: 'b', sessionId: 's2' })];
        expect(serializeTabs(tabs, 'b')!.activeTabId).toBe('b');
    });

    it('returns null when nothing is restorable', () => {
        const tabs: Tab[] = [
            { id: 'b', agentDir: null, sessionId: null, view: 'launcher', title: 'New Tab' },
        ];
        expect(serializeTabs(tabs, 'b')).toBeNull();
    });

    it('de-dupes by tab id (duplicate ids collide as React keys / owner ids)', () => {
        const tabs = [
            chatTab({ id: 'same', sessionId: 's1' }),
            chatTab({ id: 'same', sessionId: 's2' }),
        ];
        const state = serializeTabs(tabs, 'same')!;
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].sessionId).toBe('s1');
    });

    it('caps at MAX_TABS', () => {
        const tabs = Array.from({ length: MAX_TABS + 5 }, (_, i) =>
            chatTab({ id: `t${i}`, sessionId: `s${i}` }),
        );
        expect(serializeTabs(tabs, 't0')!.tabs).toHaveLength(MAX_TABS);
    });
});

describe('deserializeTabs', () => {
    it('round-trips a serialized state', () => {
        const tabs = [chatTab({ id: 'a', sessionId: 's1' }), chatTab({ id: 'b', sessionId: 's2' })];
        const state = serializeTabs(tabs, 'b')!;
        const back = deserializeTabs(JSON.stringify(state));
        expect(back).toEqual(state);
    });

    it('returns null on bad JSON', () => {
        expect(deserializeTabs('{not json')).toBeNull();
        expect(deserializeTabs(null)).toBeNull();
        expect(deserializeTabs('')).toBeNull();
    });

    it('returns null on version mismatch', () => {
        const raw = JSON.stringify({ version: 99, tabs: [{ id: 'a', agentDir: '/ws', sessionId: 's', title: 't' }], activeTabId: 'a' });
        expect(deserializeTabs(raw)).toBeNull();
    });

    it('skips malformed tab entries and pending sessions', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [
                { id: 'a', agentDir: '/ws', sessionId: 's-a', title: 'A' },
                { id: 'b', sessionId: 's-b', title: 'missing agentDir' },
                { id: 'c', agentDir: '/ws', sessionId: 'pending-x', title: 'pending' },
                { id: 'd', agentDir: '/ws', sessionId: 's-d' }, // missing title
                'garbage',
            ],
            activeTabId: 'a',
        });
        const back = deserializeTabs(raw)!;
        expect(back.tabs.map((t) => t.id)).toEqual(['a']);
    });

    it('re-dedups and re-caps defensively', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [
                { id: 'a', agentDir: '/ws', sessionId: 'dup', title: 'A' },
                { id: 'b', agentDir: '/ws', sessionId: 'dup', title: 'B' },
            ],
            activeTabId: 'b',
        });
        const back = deserializeTabs(raw)!;
        expect(back.tabs.map((t) => t.id)).toEqual(['a']);
        expect(back.activeTabId).toBe('a'); // b deduped → fallback
    });

    it('de-dupes by tab id on read too', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [
                { id: 'same', agentDir: '/ws', sessionId: 's1', title: 'A' },
                { id: 'same', agentDir: '/ws', sessionId: 's2', title: 'B' },
            ],
            activeTabId: 'same',
        });
        expect(deserializeTabs(raw)!.tabs).toHaveLength(1);
    });

    it('falls back activeTabId to first tab when stored active is gone', () => {
        const raw = JSON.stringify({
            version: 1,
            tabs: [{ id: 'a', agentDir: '/ws', sessionId: 's', title: 'A' }],
            activeTabId: 'missing',
        });
        expect(deserializeTabs(raw)!.activeTabId).toBe('a');
    });

    it('returns null when no valid tabs remain', () => {
        const raw = JSON.stringify({ version: 1, tabs: [{ id: 'a' }], activeTabId: 'a' });
        expect(deserializeTabs(raw)).toBeNull();
    });
});
