import { describe, it, expect } from 'vitest';
import type { SlashCommand } from '../../shared/slashCommands';
import { filterAndSortCommands } from './SlashCommandMenu';

const cmd = (name: string, source: SlashCommand['source']): SlashCommand => ({
  name,
  description: `${name} description`,
  source,
});

describe('filterAndSortCommands', () => {
  it('ranks builtins before user skills/commands with no query, even when alphabetically later', () => {
    const input = [
      cmd('apple-notes', 'skill'),
      cmd('compact', 'builtin'),
      cmd('bird', 'custom'),
      cmd('loop', 'builtin'),
    ];
    const out = filterAndSortCommands(input, '');
    // builtins first (alphabetical within tier), then the rest
    expect(out.map((c) => c.name)).toEqual(['compact', 'loop', 'apple-notes', 'bird']);
  });

  it('surfaces the builtin /loop above a user skill that also matches "lo"', () => {
    const input = [
      cmd('local-skill', 'skill'),
      cmd('loop', 'builtin'),
    ];
    const out = filterAndSortCommands(input, 'lo');
    expect(out[0].name).toBe('loop');
  });

  it('keeps prefix-match-first ordering within the builtin tier', () => {
    // 'cost' has 'co' as a prefix; 'compact' too — both prefix. 'context' also.
    // A builtin whose name only contains the query as a substring ranks after
    // prefix matches within the same tier.
    const input = [
      cmd('zzco', 'builtin'), // substring match only
      cmd('context', 'builtin'), // prefix match
    ];
    const out = filterAndSortCommands(input, 'co');
    expect(out.map((c) => c.name)).toEqual(['context', 'zzco']);
  });

  it('filters out non-matching commands', () => {
    const input = [cmd('loop', 'builtin'), cmd('apple', 'skill')];
    const out = filterAndSortCommands(input, 'loop');
    expect(out.map((c) => c.name)).toEqual(['loop']);
  });

  it('matches on description too, but builtins still rank first', () => {
    const input = [
      cmd('skill-x', 'skill'), // name no match
      { name: 'review', description: '审查 xyzmatch 代码', source: 'builtin' as const },
    ];
    // give skill-x a matching description
    input[0] = { name: 'skill-x', description: 'has xyzmatch token', source: 'skill' };
    const out = filterAndSortCommands(input, 'xyzmatch');
    expect(out.map((c) => c.name)).toEqual(['review', 'skill-x']);
  });
});
