import { describe, expect, it } from 'vitest';

import {
  describeTerminalReason,
  shouldRecordTurnForTitle,
  shouldSurfaceTerminalReason,
} from './terminalReason';

describe('describeTerminalReason — banner suppression', () => {
  it('returns null for non-disruptive reasons (completed + any aborted_*)', () => {
    expect(describeTerminalReason('completed')).toBeNull();
    expect(describeTerminalReason('aborted_streaming')).toBeNull();
    expect(describeTerminalReason('aborted_tools')).toBeNull();
    // Prefix match by design — a future aborted_* value is auto-suppressed.
    expect(describeTerminalReason('aborted_init')).toBeNull();
  });

  it('returns null for missing / non-string input (no crash, no banner)', () => {
    expect(describeTerminalReason(undefined)).toBeNull();
    expect(describeTerminalReason(null)).toBeNull();
    expect(describeTerminalReason('')).toBeNull();
    expect(describeTerminalReason(42)).toBeNull();
  });
});

describe('describeTerminalReason — known reasons map to severity', () => {
  it('maps known error reasons with severity "error"', () => {
    expect(describeTerminalReason('prompt_too_long')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('blocking_limit')).toMatchObject({ severity: 'error' });
    expect(describeTerminalReason('stop_hook_prevented')).toMatchObject({ severity: 'error' });
  });

  it('maps notice-level reasons with severity "notice"', () => {
    expect(describeTerminalReason('max_turns')).toMatchObject({ severity: 'notice' });
    expect(describeTerminalReason('rapid_refill_breaker')).toMatchObject({ severity: 'notice' });
  });

  it('gives every known reason a non-empty label + detail', () => {
    const info = describeTerminalReason('model_error');
    expect(info?.label).toBeTruthy();
    expect(info?.detail).toBeTruthy();
  });
});

describe('describeTerminalReason — unknown values degrade gracefully', () => {
  it('returns a notice placeholder embedding the raw value (no exhaustive-switch crash)', () => {
    const info = describeTerminalReason('some_future_reason');
    expect(info).not.toBeNull();
    expect(info?.severity).toBe('notice');
    expect(info?.label).toContain('some_future_reason');
  });
});

describe('shouldSurfaceTerminalReason', () => {
  it('is the inverse of "describe returned null"', () => {
    expect(shouldSurfaceTerminalReason('completed')).toBe(false);
    expect(shouldSurfaceTerminalReason('aborted_streaming')).toBe(false);
    expect(shouldSurfaceTerminalReason(undefined)).toBe(false);
    expect(shouldSurfaceTerminalReason('prompt_too_long')).toBe(true);
    expect(shouldSurfaceTerminalReason('some_future_reason')).toBe(true);
  });
});

describe('shouldRecordTurnForTitle — #245 round-acceptance gate', () => {
  it('accepts completed (the only "good" SDK terminal_reason)', () => {
    expect(shouldRecordTurnForTitle('completed')).toBe(true);
  });

  it('accepts undefined / null / empty (external runtimes do not emit terminal_reason)', () => {
    expect(shouldRecordTurnForTitle(undefined)).toBe(true);
    expect(shouldRecordTurnForTitle(null)).toBe(true);
    expect(shouldRecordTurnForTitle('')).toBe(true);
  });

  it('rejects the #245 culprit: aborted_streaming (SDK abort after upstream 4xx, partial assistant content is the error string)', () => {
    expect(shouldRecordTurnForTitle('aborted_streaming')).toBe(false);
    expect(shouldRecordTurnForTitle('aborted_tools')).toBe(false);
    // Future aborted_* values also rejected — partial content is partial content.
    expect(shouldRecordTurnForTitle('aborted_init')).toBe(false);
  });

  it('rejects upstream-error and limit reasons (content is degenerate or absent)', () => {
    expect(shouldRecordTurnForTitle('prompt_too_long')).toBe(false);
    expect(shouldRecordTurnForTitle('blocking_limit')).toBe(false);
    expect(shouldRecordTurnForTitle('rapid_refill_breaker')).toBe(false);
    expect(shouldRecordTurnForTitle('stop_hook_prevented')).toBe(false);
    expect(shouldRecordTurnForTitle('hook_stopped')).toBe(false);
    expect(shouldRecordTurnForTitle('image_error')).toBe(false);
    expect(shouldRecordTurnForTitle('model_error')).toBe(false);
  });

  it('rejects max_turns and tool_deferred (text may be truncated mid-thought; conservative)', () => {
    expect(shouldRecordTurnForTitle('max_turns')).toBe(false);
    expect(shouldRecordTurnForTitle('tool_deferred')).toBe(false);
  });

  it('rejects unknown / future reasons (default-deny — never widen on unrecognized values)', () => {
    expect(shouldRecordTurnForTitle('some_future_reason')).toBe(false);
  });

  it('treats non-string types like "field missing" → accept (degrade gracefully, do not silently kill title-gen)', () => {
    // Same shape as undefined/null/'': callers should not be silently locked out
    // of title-gen by an encoding bug somewhere upstream that turns terminal_reason
    // into a non-string value. The renderer's title-gen is non-critical (frontend
    // falls back to truncated first message) — over-rejection is worse than the
    // occasional bad title.
    expect(shouldRecordTurnForTitle(42)).toBe(true);
    expect(shouldRecordTurnForTitle({})).toBe(true);
    expect(shouldRecordTurnForTitle(false)).toBe(true);
  });
});
