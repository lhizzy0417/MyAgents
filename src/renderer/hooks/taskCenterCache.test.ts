import { beforeEach, describe, expect, it } from 'vitest';

import {
    decideTaskCenterMount,
    readTaskCenterCache,
    writeTaskCenterCache,
    markSessionDeleted,
    isSessionDeleted,
    __resetTaskCenterCacheForTest,
    type TaskCenterCacheData,
} from './taskCenterCache';

const TTL = 2_000;

function emptyData(): TaskCenterCacheData {
    return { sessions: [], cronTasks: [], tasks: [], backgroundSessionIds: [], agentStatuses: {}, agents: [] };
}

beforeEach(() => __resetTaskCenterCacheForTest());

describe('decideTaskCenterMount — SWR mount policy', () => {
    it('cache miss → loud first load (spinner), no seed', () => {
        expect(decideTaskCenterMount(null, 1000, TTL)).toEqual({
            seedData: null,
            initialLoading: true,
            revalidate: true,
            silent: false,
        });
    });

    it('fresh cache → serve instantly, skip revalidate', () => {
        const data = emptyData();
        const d = decideTaskCenterMount({ data, updatedAt: 1000 }, 1000 + (TTL - 1), TTL);
        expect(d.seedData).toBe(data);
        expect(d.initialLoading).toBe(false);
        expect(d.revalidate).toBe(false);
        expect(d.silent).toBe(true);
    });

    it('stale cache → serve instantly, revalidate silently', () => {
        const data = emptyData();
        const d = decideTaskCenterMount({ data, updatedAt: 1000 }, 1000 + TTL, TTL);
        expect(d.seedData).toBe(data);
        expect(d.initialLoading).toBe(false);
        expect(d.revalidate).toBe(true);
        expect(d.silent).toBe(true);
    });

    it('ttl boundary is exclusive — exactly ttl old counts as stale (revalidate)', () => {
        const d = decideTaskCenterMount({ data: emptyData(), updatedAt: 0 }, TTL, TTL);
        expect(d.revalidate).toBe(true);
    });

    it('one ms under ttl is still fresh (no revalidate)', () => {
        const d = decideTaskCenterMount({ data: emptyData(), updatedAt: 0 }, TTL - 1, TTL);
        expect(d.revalidate).toBe(false);
    });

    it('a future timestamp (clock moved backward) is treated as stale, not fresh-forever', () => {
        const data = emptyData();
        const d = decideTaskCenterMount({ data, updatedAt: 5000 }, 1000, TTL);
        expect(d.revalidate).toBe(true); // negative age must not count as fresh
        expect(d.seedData).toBe(data);   // still serves the seed instantly
    });
});

describe('deleted-session tombstones (shared across hook instances)', () => {
    it('marks and reports deleted ids', () => {
        expect(isSessionDeleted('s1')).toBe(false);
        markSessionDeleted('s1');
        expect(isSessionDeleted('s1')).toBe(true);
        expect(isSessionDeleted('s2')).toBe(false);
    });

    it('reset clears tombstones', () => {
        markSessionDeleted('s1');
        __resetTaskCenterCacheForTest();
        expect(isSessionDeleted('s1')).toBe(false);
    });
});

describe('task center cache store', () => {
    it('reads null before any write', () => {
        expect(readTaskCenterCache()).toBeNull();
    });

    it('write then read round-trips data + timestamp by reference', () => {
        const data = emptyData();
        writeTaskCenterCache(data, 4242);
        const entry = readTaskCenterCache();
        expect(entry).not.toBeNull();
        expect(entry!.data).toBe(data);
        expect(entry!.updatedAt).toBe(4242);
    });

    it('latest write wins', () => {
        writeTaskCenterCache(emptyData(), 1);
        const second = emptyData();
        writeTaskCenterCache(second, 2);
        expect(readTaskCenterCache()!.data).toBe(second);
        expect(readTaskCenterCache()!.updatedAt).toBe(2);
    });

    it('reset clears the cache', () => {
        writeTaskCenterCache(emptyData(), 1);
        __resetTaskCenterCacheForTest();
        expect(readTaskCenterCache()).toBeNull();
    });

    it('end-to-end: a real write makes the next mount seed instantly', () => {
        const data = emptyData();
        writeTaskCenterCache(data, 1000);
        const d = decideTaskCenterMount(readTaskCenterCache(), 1500, TTL);
        expect(d.seedData).toBe(data);
        expect(d.initialLoading).toBe(false);
        expect(d.silent).toBe(true);
    });
});
