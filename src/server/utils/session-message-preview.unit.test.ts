import { describe, expect, it } from 'vitest';

import {
  CLIENT_MESSAGE_INLINE_MAX_BYTES,
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
});
