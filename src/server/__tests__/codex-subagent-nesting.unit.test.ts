// PRD 0.2.27 — Codex sub-agent (collab-agent) tool nesting: thread correlation.
//
// These cover the PURE decision logic that decides whether a Codex item's tool
// events nest under a spawn card (and which one). The stateful glue (handler
// stamping, external-session routing) is exercised by typecheck + manual runs;
// the brittle, easy-to-regress part is the thread→card resolution, tested here.

import { describe, expect, it } from 'vitest';

import {
  resolveTopLevelSpawnCard,
  parseSubAgentThreadSource,
  recordSpawnAgentChildThreads,
  computeSubAgentScope,
  isChildThreadGatedMethod,
  resolveCollabAgentControlParents,
  subagentControlToolUseId,
  buildCollabAgentControlStartEvents,
  buildCollabAgentControlCompletedEvents,
  resolveCollabControlCompletionRoute,
} from '../runtimes/codex';

describe('resolveTopLevelSpawnCard', () => {
  it('returns null for the main thread (no card, no parent) → renders flat', () => {
    expect(resolveTopLevelSpawnCard('main', new Map(), new Map())).toBeNull();
  });

  it('returns null for an unknown thread → renders flat (no lost calls)', () => {
    const cards = new Map([['child', 'cardA']]);
    expect(resolveTopLevelSpawnCard('stranger', cards, new Map())).toBeNull();
  });

  it('resolves a direct child to its spawn card', () => {
    const cards = new Map([['child', 'cardA']]);
    const parents = new Map([['child', 'main']]);
    expect(resolveTopLevelSpawnCard('child', cards, parents)).toBe('cardA');
  });

  it('attributes a grandchild tool to the TOP-LEVEL (first-level) spawn card', () => {
    // main → spawns A (cardA on main); A → spawns B (cardB on A). B runs a tool.
    // One-level UI: B's tool nests under cardA, not cardB.
    const cards = new Map([['A', 'cardA'], ['B', 'cardB']]);
    const parents = new Map([['A', 'main'], ['B', 'A']]);
    expect(resolveTopLevelSpawnCard('B', cards, parents)).toBe('cardA');
  });

  it('attributes a deep (3-level) descendant to the first-level card', () => {
    const cards = new Map([['A', 'cardA'], ['B', 'cardB'], ['C', 'cardC']]);
    const parents = new Map([['A', 'main'], ['B', 'A'], ['C', 'B']]);
    expect(resolveTopLevelSpawnCard('C', cards, parents)).toBe('cardA');
  });

  it('is cycle-safe (malformed parent chain does not hang)', () => {
    const cards = new Map([['X', 'cardX']]);
    const parents = new Map([['X', 'Y'], ['Y', 'X']]); // X→Y→X loop
    // X has a card; the highest-ancestor card seen wins; loop is bounded by visited.
    expect(resolveTopLevelSpawnCard('X', cards, parents)).toBe('cardX');
  });

  it('walks past intermediate threads that have no card', () => {
    // child has no card itself but its parent (a spawned thread) does.
    const cards = new Map([['A', 'cardA']]);
    const parents = new Map([['child', 'A'], ['A', 'main']]);
    expect(resolveTopLevelSpawnCard('child', cards, parents)).toBe('cardA');
  });
});

describe('parseSubAgentThreadSource', () => {
  it('extracts parent + nickname + role from a thread_spawn source (snake_case wire)', () => {
    const thread = {
      id: 'child-1',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'main',
            depth: 0,
            agent_nickname: 'henan-worker',
            agent_role: 'data-backfill',
          },
        },
      },
    };
    expect(parseSubAgentThreadSource(thread)).toEqual({
      parentThreadId: 'main',
      nickname: 'henan-worker',
      role: 'data-backfill',
    });
  });

  it('falls back to Thread-level agentNickname/agentRole when spawn names absent', () => {
    const thread = {
      id: 'child-2',
      agentNickname: 'fallback-nick',
      agentRole: 'fallback-role',
      source: { subagent: { thread_spawn: { parent_thread_id: 'main' } } },
    };
    expect(parseSubAgentThreadSource(thread)).toEqual({
      parentThreadId: 'main',
      nickname: 'fallback-nick',
      role: 'fallback-role',
    });
  });

  it('tolerates the legacy camelCase outer variant key (subAgent)', () => {
    // v2 app-server uses "subagent" (lowercase); the legacy root schema uses
    // "subAgent". Parser accepts both so a Codex version drift can't silently
    // kill correlation.
    const thread = {
      id: 'child-3',
      source: { subAgent: { thread_spawn: { parent_thread_id: 'main', agent_nickname: 'n', agent_role: 'r' } } },
    };
    expect(parseSubAgentThreadSource(thread)).toEqual({ parentThreadId: 'main', nickname: 'n', role: 'r' });
  });

  it('returns null for a non-subagent source (e.g. a user thread)', () => {
    expect(parseSubAgentThreadSource({ id: 't', source: 'cli' })).toBeNull();
  });

  it('returns null for review/compact string sub-agent sources (no thread_spawn)', () => {
    expect(parseSubAgentThreadSource({ id: 't', source: { subagent: 'review' } })).toBeNull();
  });

  it('returns null when parent_thread_id is missing', () => {
    expect(parseSubAgentThreadSource({ id: 't', source: { subagent: { thread_spawn: {} } } })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(parseSubAgentThreadSource(undefined)).toBeNull();
    expect(parseSubAgentThreadSource('x')).toBeNull();
  });
});

describe('recordSpawnAgentChildThreads', () => {
  it('maps each receiver thread to the spawn card for spawnAgent', () => {
    const proc = { subThreadToCard: new Map<string, string>() };
    recordSpawnAgentChildThreads(proc, 'spawnAgent', 'card-1', ['c1', 'c2']);
    expect(proc.subThreadToCard.get('c1')).toBe('card-1');
    expect(proc.subThreadToCard.get('c2')).toBe('card-1');
  });

  it('does NOT remap for wait/closeAgent/sendInput (they reference existing children)', () => {
    const proc = { subThreadToCard: new Map<string, string>([['c1', 'spawn-card']]) };
    recordSpawnAgentChildThreads(proc, 'wait', 'wait-card', ['c1']);
    recordSpawnAgentChildThreads(proc, 'closeAgent', 'close-card', ['c1']);
    recordSpawnAgentChildThreads(proc, 'sendInput', 'send-card', ['c1']);
    // still points at the original spawn card, not the wait/close/send card
    expect(proc.subThreadToCard.get('c1')).toBe('spawn-card');
  });

  it('is a no-op when receiverThreadIds is empty/missing (item/started before assignment)', () => {
    const proc = { subThreadToCard: new Map<string, string>() };
    recordSpawnAgentChildThreads(proc, 'spawnAgent', 'card-1', []);
    recordSpawnAgentChildThreads(proc, 'spawnAgent', 'card-1', undefined);
    expect(proc.subThreadToCard.size).toBe(0);
  });
});

describe('computeSubAgentScope', () => {
  const cards = new Map([['child', 'cardA']]);
  const parents = new Map([['child', 'main']]);
  const meta = new Map([['child', { nickname: 'nick', role: 'role' }]]);

  it('returns null for a main-thread item (the spawn card itself stays flat)', () => {
    expect(computeSubAgentScope('main', 'main', cards, parents, meta)).toBeNull();
  });

  it('returns null when threadId is undefined', () => {
    expect(computeSubAgentScope(undefined, 'main', cards, parents, meta)).toBeNull();
  });

  it('returns null for an unmapped thread (degrade to flat, no lost calls)', () => {
    expect(computeSubAgentScope('orphan', 'main', cards, parents, meta)).toBeNull();
  });

  it('returns the spawn card + nickname/role for a sub-agent thread item', () => {
    expect(computeSubAgentScope('child', 'main', cards, parents, meta)).toEqual({
      parentToolUseId: 'cardA',
      nickname: 'nick',
      role: 'role',
    });
  });

  it('returns scope with undefined nickname/role when meta is absent', () => {
    expect(computeSubAgentScope('child', 'main', cards, parents, new Map())).toEqual({
      parentToolUseId: 'cardA',
      nickname: undefined,
      role: undefined,
    });
  });
});

describe('resolveCollabAgentControlParents', () => {
  it('maps main-thread wait/send/close receiver threads back to their spawn cards', () => {
    const cards = new Map([['child', 'spawn-card']]);
    const parents = new Map([['child', 'main']]);

    expect(resolveCollabAgentControlParents('wait', ['child'], cards, parents)).toEqual(['spawn-card']);
    expect(resolveCollabAgentControlParents('sendInput', ['child'], cards, parents)).toEqual(['spawn-card']);
    expect(resolveCollabAgentControlParents('closeAgent', ['child'], cards, parents)).toEqual(['spawn-card']);
  });

  it('deduplicates multiple receiver threads that resolve to the same top-level spawn card', () => {
    const cards = new Map([['child', 'spawn-card'], ['grandchild', 'nested-card']]);
    const parents = new Map([['child', 'main'], ['grandchild', 'child']]);

    expect(resolveCollabAgentControlParents('wait', ['child', 'grandchild'], cards, parents)).toEqual(['spawn-card']);
  });

  it('preserves order when one control action targets multiple spawn cards', () => {
    const cards = new Map([['a', 'spawn-a'], ['b', 'spawn-b']]);
    const parents = new Map([['a', 'main'], ['b', 'main']]);

    expect(resolveCollabAgentControlParents('wait', ['b', 'a'], cards, parents)).toEqual(['spawn-b', 'spawn-a']);
  });

  it('returns empty for spawnAgent and unknown receivers', () => {
    const cards = new Map([['child', 'spawn-card']]);
    const parents = new Map([['child', 'main']]);

    expect(resolveCollabAgentControlParents('spawnAgent', ['child'], cards, parents)).toEqual([]);
    expect(resolveCollabAgentControlParents('wait', ['missing'], cards, parents)).toEqual([]);
  });
});

describe('collab control event builders', () => {
  it('uses a stable per-parent synthetic id for nested control events', () => {
    expect(subagentControlToolUseId('wait-1', 'spawn-a')).toBe('wait-1::subagent-control::spawn-a');
    expect(subagentControlToolUseId('wait-1', 'spawn-a')).not.toBe(subagentControlToolUseId('wait-1', 'spawn-b'));
  });

  it('builds nested start events for resolved non-spawn control actions', () => {
    const events = buildCollabAgentControlStartEvents({
      id: 'wait-1',
      tool: 'wait',
      receiverThreadIds: ['child'],
    }, ['spawn-card']);

    expect(events).toEqual([{
      kind: 'tool_use_start',
      toolUseId: 'wait-1::subagent-control::spawn-card',
      toolName: 'CollabAgent',
      input: { tool: 'wait', receiverThreadIds: ['child'] },
      subAgent: { parentToolUseId: 'spawn-card' },
    }]);
  });

  it('builds nested completion events for resolved control actions', () => {
    const events = buildCollabAgentControlCompletedEvents({
      id: 'close-1',
      tool: 'closeAgent',
      receiverThreadIds: ['child'],
    }, ['spawn-card']);

    expect(events.map((event) => event.kind)).toEqual(['tool_use_start', 'tool_use_stop', 'tool_result']);
    expect(events.every((event) => 'subAgent' in event && event.subAgent?.parentToolUseId === 'spawn-card')).toBe(true);
    expect(events.every((event) => 'toolUseId' in event && event.toolUseId === 'close-1::subagent-control::spawn-card')).toBe(true);
  });

  it('omits duplicate start when the control action already started under a latched parent', () => {
    const route = resolveCollabControlCompletionRoute(['spawn-a', 'spawn-b'], ['spawn-a']);
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-1',
      tool: 'wait',
      receiverThreadIds: ['a'],
    }, route.parentToolUseIds, { includeStart: route.includeStart });

    expect(route).toEqual({ parentToolUseIds: ['spawn-a', 'spawn-b'], includeStart: false });
    expect(events.map((event) => event.kind)).toEqual(['tool_use_stop', 'tool_result', 'tool_use_stop', 'tool_result']);
    expect(events.map((event) => 'toolUseId' in event ? event.toolUseId : null)).toEqual([
      'wait-1::subagent-control::spawn-a',
      'wait-1::subagent-control::spawn-a',
      'wait-1::subagent-control::spawn-b',
      'wait-1::subagent-control::spawn-b',
    ]);
  });

  it('includes start when a control action first resolves on completion', () => {
    const route = resolveCollabControlCompletionRoute(undefined, ['spawn-card']);
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-1',
      tool: 'wait',
    }, route.parentToolUseIds, { includeStart: route.includeStart });

    expect(route).toEqual({ parentToolUseIds: ['spawn-card'], includeStart: true });
    expect(events.map((event) => event.kind)).toEqual(['tool_use_start', 'tool_use_stop', 'tool_result']);
  });

  it('marks failed collab control results as errors', () => {
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-failed',
      tool: 'wait',
      status: 'failed',
    }, ['spawn-card']);

    const result = events.find((event) => event.kind === 'tool_result');
    expect(result).toMatchObject({
      kind: 'tool_result',
      isError: true,
      content: 'Tool: wait\nStatus: failed',
    });
  });

  it('falls back to one complete flat card when Codex never reports control receivers', () => {
    const events = buildCollabAgentControlCompletedEvents({
      id: 'wait-orphan',
      tool: 'wait',
    }, []);

    expect(events).toEqual([
      { kind: 'tool_use_start', toolUseId: 'wait-orphan', toolName: 'CollabAgent', input: { tool: 'wait' } },
      { kind: 'tool_use_stop', toolUseId: 'wait-orphan' },
      { kind: 'tool_result', toolUseId: 'wait-orphan', content: 'Tool: wait' },
    ]);
  });
});

describe('isChildThreadGatedMethod', () => {
  // Live-verified (Codex 0.135.0): spawned child threads emit their own
  // turn/started + turn/completed (isMain=false) over the same connection.
  // These lifecycle methods must be gated to the main thread; child item
  // notifications (the tools we nest) must NOT be gated.
  it('gates thread/turn lifecycle methods', () => {
    expect(isChildThreadGatedMethod('turn/started')).toBe(true);
    expect(isChildThreadGatedMethod('turn/completed')).toBe(true);
    expect(isChildThreadGatedMethod('thread/status/changed')).toBe(true);
    expect(isChildThreadGatedMethod('thread/closed')).toBe(true);
  });
  // PRD 0.2.32 cross-review (codex HIGH): a sub-agent child thread also emits
  // thread/tokenUsage/updated { threadId, turnId, tokenUsage }. Before the fix
  // it was NOT gated, so a child's usage flowed through as a `usage` event and
  // polluted the MAIN session's context indicator + persisted lastContextUsage.
  // It must now be gated like lifecycle so the foreign-thread guard drops it.
  it('gates thread/tokenUsage/updated (child usage must not drive main context)', () => {
    expect(isChildThreadGatedMethod('thread/tokenUsage/updated')).toBe(true);
  });
  it('does NOT gate item notifications (sub-agent tools must surface)', () => {
    expect(isChildThreadGatedMethod('item/started')).toBe(false);
    expect(isChildThreadGatedMethod('item/completed')).toBe(false);
    expect(isChildThreadGatedMethod('item/commandExecution/outputDelta')).toBe(false);
  });
});
