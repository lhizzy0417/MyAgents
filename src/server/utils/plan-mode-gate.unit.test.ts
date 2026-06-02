import { describe, it, expect } from 'vitest';
import {
  shouldBlockToolInPlanMode,
  planModeDenyMessage,
  isPlanModeInEffect,
  PLAN_MODE_READONLY_TOOLS,
  PLAN_MODE_HOST_INTERACTION_TOOLS,
} from './plan-mode-gate';

describe('shouldBlockToolInPlanMode (#295 plan-mode hard gate)', () => {
  it('never blocks outside plan mode', () => {
    for (const mode of ['auto', 'fullAgency', 'custom', 'default', 'acceptEdits', 'bypassPermissions']) {
      expect(shouldBlockToolInPlanMode('Bash', mode)).toBe(false);
      expect(shouldBlockToolInPlanMode('Edit', mode)).toBe(false);
      expect(shouldBlockToolInPlanMode('mcp__whatever__do', mode)).toBe(false);
    }
  });

  it('blocks write / side-effecting tools in plan mode (the #295 regression)', () => {
    // The exact tools from the bug report plus the common write/exec surface.
    for (const tool of [
      'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
      'Task', 'WebFetch', 'WebSearch', 'Skill',
      'mcp__gemini-image__generate', 'mcp__playwright__click',
    ]) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(true);
    }
  });

  it('allows the read-only inspection tools in plan mode', () => {
    for (const tool of PLAN_MODE_READONLY_TOOLS) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(false);
    }
  });

  it('never blocks control-transfer tools — they must reach the host for approval', () => {
    for (const tool of PLAN_MODE_HOST_INTERACTION_TOOLS) {
      expect(shouldBlockToolInPlanMode(tool, 'plan')).toBe(false);
    }
  });

  it('is case-sensitive / exact-match (an unknown tool is blocked, fail-closed)', () => {
    expect(shouldBlockToolInPlanMode('read', 'plan')).toBe(true); // not 'Read'
    expect(shouldBlockToolInPlanMode('SomeFutureTool', 'plan')).toBe(true);
  });

  it('readonly and control-transfer sets do not overlap with each other', () => {
    const overlap = (PLAN_MODE_READONLY_TOOLS as readonly string[]).filter(t =>
      (PLAN_MODE_HOST_INTERACTION_TOOLS as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });
});

describe('isPlanModeInEffect (#295 fail-closed desync window)', () => {
  it('is in effect when the local mirror says plan (UI toggle / agent config path)', () => {
    expect(isPlanModeInEffect('plan', undefined)).toBe(true);
    expect(isPlanModeInEffect('plan', 'auto')).toBe(true);
  });

  it('is in effect when the SDK hook says plan even if the async mirror lags (the critical fix)', () => {
    // AI EnterPlanMode mid-turn: SDK fires PreToolUse with permission_mode 'plan'
    // before the sidecar stream loop updates currentPermissionMode (still 'auto').
    expect(isPlanModeInEffect('auto', 'plan')).toBe(true);
    // And the gate must then BLOCK a write tool against this fail-closed mode —
    // the exact bypass that trusting only the local mirror would let through.
    const effective = isPlanModeInEffect('auto', 'plan') ? 'plan' : 'auto';
    expect(shouldBlockToolInPlanMode('Bash', effective)).toBe(true);
    expect(shouldBlockToolInPlanMode('Edit', effective)).toBe(true);
  });

  it('is NOT in effect when neither source says plan', () => {
    expect(isPlanModeInEffect('auto', undefined)).toBe(false);
    expect(isPlanModeInEffect('auto', 'auto')).toBe(false);
    expect(isPlanModeInEffect('fullAgency', 'acceptEdits')).toBe(false);
    // and a read-only allowlist tool still flows normally in that case
    const effective = isPlanModeInEffect('auto', 'auto') ? 'plan' : 'auto';
    expect(shouldBlockToolInPlanMode('Bash', effective)).toBe(false);
  });
});

describe('planModeDenyMessage', () => {
  it('names the blocked tool and points the model at ExitPlanMode', () => {
    const msg = planModeDenyMessage('Bash');
    expect(msg).toContain('Bash');
    expect(msg).toContain('ExitPlanMode');
    expect(msg).toContain('Plan');
  });
});
