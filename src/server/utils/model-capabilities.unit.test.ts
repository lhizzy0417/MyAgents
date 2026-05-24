import { describe, expect, it } from 'vitest';

import { applyContextWindowSuffix } from './model-capabilities';

// #1 recurring red line: a >=1M-context model MUST be tagged `[1m]` before it
// reaches SDK ingress, or the SDK silently falls back to the 200K window
// (/context shows 200K, auto-compact fires at ~187K, attachments truncate).
// applyContextWindowSuffix is the single chokepoint. These lock its contract.
//
// Threshold cases lean on bundled PRESET_PROVIDERS (always ingested into the
// registry): claude-opus-4-7 = 1_000_000, claude-sonnet-4-6 = 200_000.
describe('applyContextWindowSuffix — registry-independent guards', () => {
  it('returns undefined for empty / null / undefined (never overwrite a model option with "")', () => {
    expect(applyContextWindowSuffix(undefined)).toBeUndefined();
    expect(applyContextWindowSuffix(null)).toBeUndefined();
    expect(applyContextWindowSuffix('')).toBeUndefined();
  });

  it('leaves an already-[1m]-tagged id untouched (case-insensitive, no double-wrap)', () => {
    expect(applyContextWindowSuffix('foo[1m]')).toBe('foo[1m]');
    expect(applyContextWindowSuffix('claude-opus-4-7[1m]')).toBe('claude-opus-4-7[1m]');
    expect(applyContextWindowSuffix('FOO[1M]')).toBe('FOO[1M]'); // matches SDK has1mContext regex
  });

  it('leaves an unregistered model unchanged (no entry → no suffix)', () => {
    expect(applyContextWindowSuffix('totally-made-up-model-xyz')).toBe('totally-made-up-model-xyz');
  });
});

describe('applyContextWindowSuffix — threshold via preset registry', () => {
  it('tags a >=1M preset model with [1m]', () => {
    expect(applyContextWindowSuffix('claude-opus-4-7')).toBe('claude-opus-4-7[1m]');
    expect(applyContextWindowSuffix('claude-opus-4-6')).toBe('claude-opus-4-6[1m]');
  });

  it('does NOT tag a 200K preset model (claude-sonnet-4-6 wire-default is 200K)', () => {
    expect(applyContextWindowSuffix('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    expect(applyContextWindowSuffix('claude-haiku-4-5')).toBe('claude-haiku-4-5');
  });
});
