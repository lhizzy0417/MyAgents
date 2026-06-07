import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '../../shared/slashCommands';
import {
  CLIENT_ACTION_SLASH_COMMANDS,
  isClientActionCommand,
  withClientActionCommands,
} from './slashActions';

const cmd = (name: string, source: SlashCommand['source']): SlashCommand => ({
  name,
  description: name,
  source,
});

describe('isClientActionCommand', () => {
  it('is true only for builtin client-action commands', () => {
    expect(isClientActionCommand(cmd('loop', 'builtin'))).toBe(true);
  });

  it('is false for a non-builtin source with the same name (no hijack of a user skill)', () => {
    expect(isClientActionCommand(cmd('loop', 'skill'))).toBe(false);
    expect(isClientActionCommand(cmd('loop', 'custom'))).toBe(false);
  });

  it('is false for ordinary builtins like /compact', () => {
    expect(isClientActionCommand(cmd('compact', 'builtin'))).toBe(false);
  });
});

describe('withClientActionCommands', () => {
  const base = [cmd('alpha', 'skill'), cmd('compact', 'builtin')];

  it('returns the list untouched when disabled (no handler wired)', () => {
    const result = withClientActionCommands(base, false);
    expect(result).toBe(base); // same reference — no allocation
    expect(result.some((c) => c.name === 'loop')).toBe(false);
  });

  it('appends client-action commands when enabled', () => {
    const result = withClientActionCommands(base, true);
    expect(result.filter((c) => c.name === 'loop')).toHaveLength(1);
    expect(result.find((c) => c.name === 'loop')?.source).toBe('builtin');
  });

  it('does not duplicate when a same-named entry already exists', () => {
    const withUserLoop = [...base, cmd('loop', 'skill')];
    const result = withClientActionCommands(withUserLoop, true);
    expect(result.filter((c) => c.name === 'loop')).toHaveLength(1);
    // The existing entry wins (mirrors the Rust scanner's first-occurrence dedup)
    expect(result.find((c) => c.name === 'loop')?.source).toBe('skill');
  });

  it('every client-action command is itself a client action', () => {
    for (const c of CLIENT_ACTION_SLASH_COMMANDS) {
      expect(isClientActionCommand(c)).toBe(true);
    }
  });
});
