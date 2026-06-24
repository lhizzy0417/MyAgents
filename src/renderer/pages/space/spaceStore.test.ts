import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  findProjectForAgent: vi.fn(),
  spaceCloseOwnIssue: vi.fn(),
  spaceCommentIssue: vi.fn(),
  spaceCreateIssue: vi.fn(),
  spaceDispatchIssue: vi.fn(),
  spaceGetIssue: vi.fn(),
  spaceGetOfficial: vi.fn(),
  spaceGetSession: vi.fn(),
  spaceGetSkill: vi.fn(),
  spaceGetSkillFile: vi.fn(),
  spaceInstallSkill: vi.fn(),
  spaceListIssues: vi.fn(),
  spaceListLocalAgents: vi.fn(),
  spaceListSkills: vi.fn(),
  spaceLogout: vi.fn(),
  spaceProcessDispatchesOnce: vi.fn(),
  spaceRegisterAgent: vi.fn(),
  spaceSetIssueStatus: vi.fn(),
  spaceUploadIssueAttachments: vi.fn(),
  spaceUploadSkillZip: vi.fn(),
}));

vi.mock('@/api/spaceCloud', () => ({
  findProjectForAgent: apiMocks.findProjectForAgent,
  spaceCloseOwnIssue: apiMocks.spaceCloseOwnIssue,
  spaceCommentIssue: apiMocks.spaceCommentIssue,
  spaceCreateIssue: apiMocks.spaceCreateIssue,
  spaceDispatchIssue: apiMocks.spaceDispatchIssue,
  spaceGetIssue: apiMocks.spaceGetIssue,
  spaceGetOfficial: apiMocks.spaceGetOfficial,
  spaceGetSession: apiMocks.spaceGetSession,
  spaceGetSkill: apiMocks.spaceGetSkill,
  spaceGetSkillFile: apiMocks.spaceGetSkillFile,
  spaceInstallSkill: apiMocks.spaceInstallSkill,
  spaceListIssues: apiMocks.spaceListIssues,
  spaceListLocalAgents: apiMocks.spaceListLocalAgents,
  spaceListSkills: apiMocks.spaceListSkills,
  spaceLogout: apiMocks.spaceLogout,
  spaceProcessDispatchesOnce: apiMocks.spaceProcessDispatchesOnce,
  spaceRegisterAgent: apiMocks.spaceRegisterAgent,
  spaceSetIssueStatus: apiMocks.spaceSetIssueStatus,
  spaceUploadIssueAttachments: apiMocks.spaceUploadIssueAttachments,
  spaceUploadSkillZip: apiMocks.spaceUploadSkillZip,
}));

import type { SpaceIssue, SpaceIssueComment, SpaceIssueDetail, SpaceSession } from '@/api/spaceCloud';
import {
  __resetSpaceStoreForTest,
  __setSpaceStoreStateForTest,
  actions,
  getIssueListState,
  getSnapshot,
} from './spaceStore';

const fakeSession: SpaceSession = {
  baseUrl: 'https://space.myagents.test',
  user: { id: 'user-1', email: 'user@example.com' },
  space: { id: 'space-1', slug: 'official', name: 'MyAgents社区', joinPolicy: 'open' },
  membership: { id: 'membership-1', role: 'owner' },
  updatedAt: '2026-06-24T00:00:00.000Z',
};

const fakeIssue: SpaceIssue = {
  id: 'iss_123',
  spaceId: 'space-1',
  title: 'Test',
  body: 'Body',
  status: 'open',
  author: { id: 'user-1', name: 'Ethan' },
  tags: [],
  commentCount: 0,
  attachmentCount: 0,
  createdAt: '2026-06-24T00:00:00.000Z',
  updatedAt: '2026-06-24T00:00:00.000Z',
};

const fakeDetail: SpaceIssueDetail = {
  issue: fakeIssue,
  comments: {
    items: [],
    hasMore: false,
    nextCursor: null,
    limit: 5,
  },
  attachments: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetSpaceStoreForTest();
  vi.clearAllMocks();
});

describe('spaceStore snapshot', () => {
  it('returns a stable snapshot reference until state changes', () => {
    const first = getSnapshot();
    const second = getSnapshot();

    expect(first).toBe(second);

    __setSpaceStoreStateForTest({ tags: [{ id: 'tag-1', name: 'bug' }] });

    expect(getSnapshot()).not.toBe(first);
  });
});

describe('spaceStore issue refresh', () => {
  it('dedupes same-key issue refreshes while a request is in flight', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const pending = deferred<{ items: SpaceIssue[]; hasMore: boolean; nextCursor: null }>();
    apiMocks.spaceListIssues.mockReturnValueOnce(pending.promise);

    const first = actions.refreshIssues({ q: ' Test ', limit: 50 }, { maxAgeMs: 30_000 });
    const second = actions.refreshIssues({ q: 'Test', limit: 50 }, { maxAgeMs: 30_000 });

    expect(apiMocks.spaceListIssues).toHaveBeenCalledTimes(1);
    expect(apiMocks.spaceListIssues).toHaveBeenCalledWith({ q: 'Test', tag: undefined, status: undefined, cursor: undefined, limit: 50 });

    pending.resolve({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await Promise.all([first, second]);

    expect(getIssueListState({ q: 'Test', limit: 50 }).items).toEqual([fakeIssue]);
  });

  it('keeps the previous issue list visible when revalidation fails', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null });

    await actions.refreshIssues({ limit: 50 }, { force: true });
    expect(getIssueListState({ limit: 50 }).items).toEqual([fakeIssue]);

    apiMocks.spaceListIssues.mockRejectedValueOnce(new Error('network down'));

    await expect(actions.refreshIssues({ limit: 50 }, { force: true, silent: true })).rejects.toThrow('network down');

    const state = getIssueListState({ limit: 50 });
    expect(state.items).toEqual([fakeIssue]);
    expect(state.isLoading).toBe(false);
    expect(state.error).toBe('network down');
  });

  it('prepends a newly created issue into already loaded lists', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ limit: 50 }, { force: true });

    const newIssue = { ...fakeIssue, id: 'iss_456', title: 'Second' };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: newIssue });

    await actions.createIssue({ title: 'Second', body: 'Body', tags: [] });

    expect(getIssueListState({ limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_456', 'iss_123']);
  });

  it('does not inject created issues into cached lists with non-matching filters', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    const bugIssue = { ...fakeIssue, tags: [{ id: 'tag-1', name: 'bug' }] };
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [bugIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ tag: 'bug', limit: 50 }, { force: true });

    const featureIssue = {
      ...fakeIssue,
      id: 'iss_456',
      title: 'Feature',
      tags: [{ id: 'tag-2', name: 'feature' }],
    };
    apiMocks.spaceCreateIssue.mockResolvedValueOnce({ issue: featureIssue });

    await actions.createIssue({ title: 'Feature', body: 'Body', tags: ['feature'] });

    expect(getIssueListState({ tag: 'bug', limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_123']);
  });

  it('moves a status-mutated issue between cached filtered lists', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues
      .mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null })
      .mockResolvedValueOnce({ items: [], hasMore: false, nextCursor: null });

    await actions.refreshIssues({ status: 'open', limit: 50 }, { force: true });
    await actions.refreshIssues({ status: 'in_progress', limit: 50 }, { force: true });

    apiMocks.spaceSetIssueStatus.mockResolvedValueOnce({
      status: 'in_progress',
      updatedAt: '2026-06-24T01:00:00.000Z',
    });

    await actions.setIssueStatus('iss_123', 'in_progress');

    expect(getIssueListState({ status: 'open', limit: 50 }).items).toEqual([]);
    expect(getIssueListState({ status: 'in_progress', limit: 50 }).items.map((issue) => issue.id)).toEqual(['iss_123']);
    expect(getIssueListState({ status: 'in_progress', limit: 50 }).items[0]?.status).toBe('in_progress');
  });

  it('patches issue detail comments and list counters after a successful comment', async () => {
    __setSpaceStoreStateForTest({ boot: 'ready', session: fakeSession });
    apiMocks.spaceListIssues.mockResolvedValueOnce({ items: [fakeIssue], hasMore: false, nextCursor: null });
    await actions.refreshIssues({ limit: 50 }, { force: true });
    __setSpaceStoreStateForTest({
      issueDetails: {
        iss_123: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    const comment: SpaceIssueComment = {
      id: 'cmt_123',
      author: { id: 'user-1', type: 'user' },
      body: '效果咋样呢？',
      createdAt: '2026-06-24T02:00:00.000Z',
    };
    apiMocks.spaceCommentIssue.mockResolvedValueOnce({ comment });

    await actions.commentIssue('iss_123', '效果咋样呢？');

    const detail = getSnapshot().issueDetails.iss_123?.detail;
    expect(detail?.comments.items).toEqual([comment]);
    expect(detail?.issue.commentCount).toBe(1);
    expect(getIssueListState({ limit: 50 }).items[0]?.commentCount).toBe(1);
  });

  it('does not patch comments when comment submission fails', async () => {
    __setSpaceStoreStateForTest({
      boot: 'ready',
      session: fakeSession,
      issueDetails: {
        iss_123: {
          detail: fakeDetail,
          lastFetchedAt: Date.now(),
          isLoading: false,
          error: null,
        },
      },
    });
    apiMocks.spaceCommentIssue.mockRejectedValueOnce(new Error('network down'));

    await expect(actions.commentIssue('iss_123', 'will fail')).rejects.toThrow('network down');

    const detail = getSnapshot().issueDetails.iss_123?.detail;
    expect(detail?.comments.items).toEqual([]);
    expect(detail?.issue.commentCount).toBe(0);
  });
});
