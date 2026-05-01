import { describe, expect, test } from 'vitest';

import { normalizeRuntime, planSessionOpen } from './sessionOpenPlan';

describe('planSessionOpen', () => {
  test('jumps to an already-open session before considering runtime', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-a',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'jump-to-tab', tabId: 'tab-a' });
  });

  test('opens a new tab when current and target sessions use different runtimes', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'claude-code',
      targetRuntime: 'codex',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({
      type: 'open-new-tab',
      reason: 'runtime-mismatch',
      currentRuntime: 'claude-code',
      targetRuntime: 'codex',
    });
  });

  test('attaches to an existing cron sidecar before checking the current tab cron state', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'codex',
      targetRuntime: 'codex',
      targetActivation: { tab_id: null, task_id: 'task-1' },
      currentTabCronRunning: true,
    })).toEqual({ type: 'attach-existing-sidecar', taskId: 'task-1' });
  });

  test('attaches to an existing cron sidecar even when runtimes differ', () => {
    // Cron-owned sessions must not be routed through the runtime-mismatch
    // new-tab path: that path calls activateSession(..., taskId: null) and
    // overwrites the cron activation record, breaking ownership.
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetActivation: { tab_id: null, task_id: 'task-1' },
      currentTabCronRunning: false,
    })).toEqual({ type: 'attach-existing-sidecar', taskId: 'task-1' });
  });

  test('does not produce a runtime-mismatch plan when multi-agent runtime is disabled', () => {
    // Single-runtime mode collapses everything to `builtin`; cross-runtime
    // tabs cannot exist, so a hot-swap in current tab is the right path.
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: false,
      currentRuntime: 'builtin',
      targetRuntime: 'codex',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'switch-current-tab' });
  });

  test('opens a new tab when current tab is running its own cron', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'builtin',
      targetActivation: null,
      currentTabCronRunning: true,
    })).toEqual({ type: 'open-new-tab', reason: 'current-cron-running' });
  });

  test('falls through to switch-current-tab for an idle target with no special owners', () => {
    expect(planSessionOpen({
      tabs: [{ id: 'tab-a', sessionId: 'session-a' }],
      targetSessionId: 'session-b',
      multiAgentRuntime: true,
      currentRuntime: 'builtin',
      targetRuntime: 'builtin',
      targetActivation: null,
      currentTabCronRunning: false,
    })).toEqual({ type: 'switch-current-tab' });
  });
});

describe('normalizeRuntime', () => {
  test('falls back to builtin for missing or unknown runtime values', () => {
    expect(normalizeRuntime(undefined)).toBe('builtin');
    expect(normalizeRuntime('unknown')).toBe('builtin');
    expect(normalizeRuntime('gemini')).toBe('gemini');
  });
});
