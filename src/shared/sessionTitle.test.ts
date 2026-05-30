import { describe, it, expect } from 'vitest';
import { stripSystemWrapper, deriveSessionTitle } from './sessionTitle';

describe('stripSystemWrapper', () => {
  it('returns plain text unchanged', () => {
    expect(stripSystemWrapper('帮我看看今天的邮件')).toBe('帮我看看今天的邮件');
  });

  it('unwraps a complete system-reminder + CRON_TASK and extracts the task title', () => {
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：# GitHub Issue 自动化处理\n</CRON_TASK>\n</system-reminder>';
    expect(stripSystemWrapper(raw)).toBe('GitHub Issue 自动化处理');
  });

  it('recovers content when the wrapper is TRUNCATED before the closing tag (the bug)', () => {
    // This is exactly the shape that used to be stored: slice(0,40) of a wrapped prompt.
    const truncated = '<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 查收今天的所有邮件';
    expect(stripSystemWrapper(truncated)).toBe('请你帮 Ethan 查收今天的所有邮件');
  });

  it('strips HEARTBEAT markers', () => {
    expect(stripSystemWrapper('<HEARTBEAT> mino，心跳唤醒，看看 wishpool')).toBe('mino，心跳唤醒，看看 wishpool');
  });

  it('returns empty for whitespace / empty input', () => {
    expect(stripSystemWrapper('')).toBe('');
    expect(stripSystemWrapper('   \n  ')).toBe('');
  });

  // --- adversarial-review regressions ---

  it('does NOT extract 执行任务 from a plain user message (no <CRON_TASK> marker) [#1]', () => {
    const userMsg = '请解释这段日志：执行任务：#123 然后呢';
    // Must return the message intact, NOT the silently-rewritten capture "123 然后呢".
    expect(stripSystemWrapper(userMsg)).toBe(userMsg);
  });

  it('stops the cron task title at the first newline, not bleeding the body in [#3]', () => {
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：每日简报\n补充说明：要包含 A/B/C 三块内容\n</CRON_TASK>\n</system-reminder>';
    expect(stripSystemWrapper(raw)).toBe('每日简报');
  });

  it('returns empty for an actual wrapper-only string [#7]', () => {
    expect(stripSystemWrapper('<system-reminder>\n<CRON_TASK>\n</CRON_TASK>\n</system-reminder>')).toBe('');
    expect(stripSystemWrapper('<system-reminder></system-reminder>')).toBe('');
  });
});

describe('deriveSessionTitle', () => {
  it('strips the wrapper BEFORE the length cap (regression: no wrapper-only scrap)', () => {
    // The raw is the wrapped cron prompt; a blind slice(0,40) would have stored
    // "<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 E...". After the fix the cap
    // applies to the REAL task text.
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 查收今天的所有未读邮件并按优先级整理成清单\n</CRON_TASK>\n</system-reminder>';
    const title = deriveSessionTitle(raw, 40);
    expect(title.startsWith('请你帮 Ethan')).toBe(true);
    expect(title).not.toContain('<');
    expect(title).not.toContain('CRON_TASK');
    expect(title).not.toContain('执行任务');
  });

  it('does NOT degrade to a 4-char scrap for the reported case', () => {
    const raw = '<system-reminder>\n<CRON_TASK>\n执行任务：请你帮 Ethan 处理邮件\n</CRON_TASK>\n</system-reminder>';
    expect(deriveSessionTitle(raw, 40)).toBe('请你帮 Ethan 处理邮件');
  });

  it('caps at maxLen and appends ellipsis only when actually truncated', () => {
    expect(deriveSessionTitle('短标题', 40)).toBe('短标题');
    const long = 'a'.repeat(60);
    const out = deriveSessionTitle(long, 40);
    expect(out).toBe('a'.repeat(40) + '...');
  });

  it('does not split a surrogate pair at the cap boundary (no lone-surrogate "�")', () => {
    // 39 ASCII + a 2-code-unit emoji straddling the 40-char cap.
    const out = deriveSessionTitle('a'.repeat(39) + '👍tail', 40);
    expect([...out].length).toBe(40 + 3); // 40 code points + "..."
    expect(out.endsWith('👍...')).toBe(true); // emoji kept whole, not severed
    // No UNPAIRED surrogate (a blind UTF-16 slice(0,40) would have left one).
    // isWellFormed() is true iff the string has no lone surrogate.
    expect(out.isWellFormed()).toBe(true);
  });

  it('returns empty for empty/whitespace/wrapper-only input (caller supplies fallback)', () => {
    expect(deriveSessionTitle('', 40)).toBe('');
    expect(deriveSessionTitle('   ', 40)).toBe('');
    expect(deriveSessionTitle(null, 40)).toBe('');
    expect(deriveSessionTitle(undefined, 40)).toBe('');
  });
});
