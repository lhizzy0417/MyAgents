import { describe, expect, it } from 'vitest';

import {
  CLIENT_MESSAGE_INLINE_MAX_BYTES,
  resolveLastRealUserMessagePreview,
  shrinkSessionMessageForClient,
} from './session-message-preview';
import type { SessionMessage } from '../types/session';

function msg(content: string): SessionMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content,
    timestamp: '2026-05-25T00:00:00.000Z',
  };
}

describe('session-message-preview', () => {
  it('keeps normal history messages unchanged by reference', () => {
    const input = msg('short message');
    expect(shrinkSessionMessageForClient(input)).toBe(input);
  });

  it('replaces oversized content with a bounded display preview', () => {
    const original = `HEAD-${'a'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}-TAIL`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).not.toBe(original);
    expect(output.content).toContain('too large for inline display');
    expect(output.content).toContain('HEAD-');
    expect(output.content).toContain('-TAIL');
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(80 * 1024);
  });

  it('keeps UTF-8 preview slices within budget without dropping the tail marker', () => {
    const original = `开头${'界'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}结尾`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).toContain('开头');
    expect(output.content).toContain('结尾');
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(90 * 1024);
  });

  it('preserves oversized structured assistant history as parseable content blocks', () => {
    const inputJson = JSON.stringify({
      command: 'npm test',
      cwd: '/tmp/project',
      large: 'input-'.repeat(20_000),
    }, null, 2);
    const resultJson = JSON.stringify({
      stdout: 'output-'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES),
      stderr: '',
      exitCode: 0,
    }, null, 2);
    const original = JSON.stringify([
      {
        type: 'thinking',
        thinking: 'thought-'.repeat(20_000),
        isComplete: true,
      },
      {
        type: 'tool_use',
        tool: {
          id: 'call_1',
          name: 'Bash',
          input: JSON.parse(inputJson),
          inputJson,
          parsedInput: JSON.parse(inputJson),
          result: resultJson,
          isLoading: false,
        },
      },
      {
        type: 'text',
        text: 'final answer',
      },
    ]);

    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content).not.toBe(original);
    expect(output.content.startsWith('[')).toBe(true);
    expect(Buffer.byteLength(output.content, 'utf8')).toBeLessThan(CLIENT_MESSAGE_INLINE_MAX_BYTES);

    const parsed = JSON.parse(output.content) as Array<{
      type: string;
      thinking?: string;
      text?: string;
      tool?: {
        id?: string;
        name?: string;
        input?: unknown;
        inputJson?: string;
        parsedInput?: unknown;
        result?: string;
      };
    }>;
    expect(parsed.map((block) => block.type)).toEqual(['thinking', 'tool_use', 'text']);
    expect(parsed[0].thinking).toContain('history display truncated');
    expect(parsed[1].tool?.id).toBe('call_1');
    expect(parsed[1].tool?.name).toBe('Bash');
    expect(parsed[1].tool?.input).toBeUndefined();
    expect(parsed[1].tool?.inputJson).toBeDefined();
    expect(parsed[1].tool?.parsedInput).toBeDefined();
    expect(JSON.parse(parsed[1].tool?.result ?? '{}')).toMatchObject({
      stderr: '',
      exitCode: 0,
    });
    expect(JSON.parse(parsed[1].tool?.result ?? '{}').stdout).toContain('history display truncated');
    expect(parsed[2].text).toBe('final answer');
  });

  it('falls back to plain preview when oversized JSON-looking content is malformed', () => {
    const original = `[{"type":"text","text":"${'x'.repeat(CLIENT_MESSAGE_INLINE_MAX_BYTES)}"`;
    const output = shrinkSessionMessageForClient(msg(original));

    expect(output.content.startsWith('This history message is too large')).toBe(true);
    expect(output.content).toContain('--- Beginning ---');
    expect(() => JSON.parse(output.content)).toThrow();
  });

  it('extracts last real user preview instead of the trailing assistant response', () => {
    const result = resolveLastRealUserMessagePreview([
      { role: 'user', content: '用户真正的问题', id: 'u1', timestamp: 't1' } as SessionMessage,
      { role: 'assistant', content: '我会先处理这个问题', id: 'a1', timestamp: 't2' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '用户真正的问题' });
  });

  it('skips pure system reminders but keeps mixed user-visible text', () => {
    const result = resolveLastRealUserMessagePreview([
      {
        role: 'user',
        content: '<system-reminder><CRON_TASK>执行任务</CRON_TASK></system-reminder>',
        id: 'system',
        timestamp: 't1',
      } as SessionMessage,
      {
        role: 'user',
        content: '<system-reminder>context</system-reminder>用户群聊消息',
        id: 'mixed',
        timestamp: 't2',
      } as SessionMessage,
      { role: 'assistant', content: 'assistant', id: 'a1', timestamp: 't3' } as SessionMessage,
    ]);

    expect(result).toEqual({ found: true, preview: '用户群聊消息' });
  });
});
