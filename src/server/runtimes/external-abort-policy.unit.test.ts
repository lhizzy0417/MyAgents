import { describe, expect, it } from 'vitest';

import { decideSessionCompleteErrorAction } from './external-abort-policy';

describe('decideSessionCompleteErrorAction — external session_complete error routing', () => {
  it('#307: a user-initiated stop is suppressed, not surfaced', () => {
    // The reported bug: stopping an external Claude Code turn mid-stream killed the
    // process → error session_complete → "Session ended with error" banner.
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: false,
        hasAssistantText: true,
        userRequestedStop: true,
      }),
    ).toBe('suppress-user-stop');

    // Even with no streamed text yet (abort lands early), still suppress.
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: false,
        hasAssistantText: false,
        userRequestedStop: true,
      }),
    ).toBe('suppress-user-stop');
  });

  it('surfaces a genuine mid-turn failure (no stop requested)', () => {
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: false,
        hasAssistantText: true,
        userRequestedStop: false,
      }),
    ).toBe('surface');
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: false,
        hasAssistantText: false,
        userRequestedStop: false,
      }),
    ).toBe('surface');
  });

  it('idle-exit (between turns, no pending text) is ignored regardless of stop flag', () => {
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: true,
        hasAssistantText: false,
        userRequestedStop: false,
      }),
    ).toBe('ignore-idle');
    // Idle-exit takes priority even if a stop was also flagged.
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: true,
        hasAssistantText: false,
        userRequestedStop: true,
      }),
    ).toBe('ignore-idle');
  });

  it('a completed turn with pending text + stop is treated as a stop (not idle)', () => {
    expect(
      decideSessionCompleteErrorAction({
        turnCompleted: true,
        hasAssistantText: true,
        userRequestedStop: true,
      }),
    ).toBe('suppress-user-stop');
  });
});
