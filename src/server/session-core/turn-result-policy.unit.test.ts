import { describe, expect, it } from 'vitest';

import {
  decideBuiltinInjectedTurnResult,
  decideExternalInjectedTurnResult,
} from './turn-result-policy';

describe('turn-result-policy', () => {
  it('does not treat idle without a builtin turn-local outcome as success', () => {
    expect(decideBuiltinInjectedTurnResult({ idleCompleted: true })).toEqual({
      success: false,
      error: 'Injected turn finished without a recorded outcome',
      status: 503,
    });
  });

  it('blocks completed for builtin turn-local errors', () => {
    expect(decideBuiltinInjectedTurnResult({
      idleCompleted: true,
      outcome: {
        status: 'error',
        assistantMessagePresent: false,
        text: '',
        error: 'SDK result error',
      },
    })).toEqual({
      success: false,
      error: 'SDK result error',
      status: 503,
    });
  });

  it('accepts a successful builtin turn-local terminal outcome', () => {
    expect(decideBuiltinInjectedTurnResult({
      idleCompleted: true,
      outcome: {
        status: 'complete',
        assistantMessagePresent: true,
        text: 'done',
      },
    })).toEqual({
      success: true,
      assistantMessagePresent: true,
      text: 'done',
    });
  });

  it('does not treat external idle as success without the runtime success signal', () => {
    expect(decideExternalInjectedTurnResult({
      idleCompleted: true,
      turnSucceeded: false,
      text: 'stale answer',
    })).toEqual({
      success: false,
      error: 'External runtime turn failed',
      status: 503,
    });
  });

  it('times out both builtin and external injected turns before success gates', () => {
    expect(decideBuiltinInjectedTurnResult({ idleCompleted: false })).toEqual({
      success: false,
      error: 'Execution timed out',
      status: 408,
    });
    expect(decideExternalInjectedTurnResult({ idleCompleted: false })).toEqual({
      success: false,
      error: 'Execution timed out',
      status: 408,
    });
  });
});
