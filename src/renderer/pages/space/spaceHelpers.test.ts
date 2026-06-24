import { describe, expect, it } from 'vitest';

import type { LocalRegisteredAgent, SpaceIssue, SpaceSession } from '@/api/spaceCloud';
import type { Project } from '@/config/types';
import {
  buildIssueCommandPrompt,
  buildIssueQueryKey,
  formatAgentSecondaryLabel,
  getIssueStatusOptions,
  isClosedIssue,
} from './spaceHelpers';

const session = (role: SpaceSession['membership']['role'], userId = 'user-1'): SpaceSession => ({
  baseUrl: 'https://space.myagents.test',
  user: { id: userId, email: 'user@example.com' },
  space: { id: 'space-1', slug: 'official', name: 'MyAgents社区', joinPolicy: 'open' },
  membership: { id: 'membership-1', role },
  updatedAt: '2026-06-24T00:00:00.000Z',
});

const issue = (overrides: Partial<SpaceIssue> = {}): SpaceIssue => ({
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
  ...overrides,
});

describe('space issue helpers', () => {
  it('builds a stable issue query key from normalized filters', () => {
    expect(buildIssueQueryKey({ q: '  crash ', tag: ' bug ', status: ' open ', limit: 50 })).toBe(
      'q=crash&tag=bug&status=open&cursor=&limit=50',
    );
  });

  it('builds the issue command prompt around the short CLI alias', () => {
    const prompt = buildIssueCommandPrompt({ spaceName: 'MyAgents社区', issueId: 'iss_123' });

    expect(prompt).toContain('这是来自「MyAgents社区」团队空间的 issue');
    expect(prompt).toContain('请先读取该 issue');
    expect(prompt).toContain('myagents issue iss_123');
    expect(prompt).toContain('myagents space issue get iss_123 --json');
  });

  it('exposes status options by permission', () => {
    const ownerOptions = getIssueStatusOptions({ session: session('owner'), issue: issue() });
    expect(ownerOptions.map((option) => option.value)).toEqual([
      'open',
      'triaged',
      'in_progress',
      'resolved',
      'closed',
      'declined',
      'duplicate',
      'archived',
    ]);

    expect(getIssueStatusOptions({ session: session('member'), issue: issue() })).toEqual([
      { value: 'closed', label: 'Close issue', kind: 'close-own' },
    ]);
    expect(getIssueStatusOptions({ session: session('member', 'other-user'), issue: issue() })).toEqual([]);
    expect(getIssueStatusOptions({ session: session('member'), issue: issue({ status: 'closed' }) })).toEqual([]);
  });

  it('formats agent workspace labels through project identity first', () => {
    const projects = [
      { id: 'project-1', path: '/workspace/a', name: 'Repo A', displayName: 'Workspace A' },
    ] as Project[];
    const agent = {
      id: 'agent-1',
      baseUrl: 'https://space.myagents.test',
      spaceId: 'space-1',
      workspaceId: 'project-1',
      displayName: 'Builder',
      workspacePath: '/workspace/a',
      workspaceLabel: 'Stored label',
      goalMd: 'Handle issues',
      status: 'active',
      createdAt: '2026-06-24T00:00:00.000Z',
      updatedAt: '2026-06-24T00:00:00.000Z',
    } satisfies LocalRegisteredAgent;

    expect(formatAgentSecondaryLabel(agent, projects)).toBe('Workspace A');
    expect(isClosedIssue('duplicate')).toBe(true);
  });
});
