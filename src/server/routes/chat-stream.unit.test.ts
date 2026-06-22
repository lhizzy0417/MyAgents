import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engine: {
    getStreamReplaySnapshot: vi.fn(() => ({
      initState: { sessionState: 'idle' },
      replayMessages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
      ],
      systemInitPayload: { info: { model: 'claude' } },
      pendingInteractiveRequests: [
        { type: 'chat:permission-request', data: { requestId: 'perm-1' } },
      ],
    })),
  },
}));

vi.mock('../session-engine', () => ({
  getSessionEngine: () => mocks.engine,
}));

import { handleChatStreamRoute } from './chat-stream';

describe('handleChatStreamRoute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the active engine replay snapshot over SSE in legacy event order', async () => {
    const sent: Array<{ event: string; data: unknown }> = [];
    const response = new Response('stream');

    const result = await handleChatStreamRoute(
      '/chat/stream',
      new Request('http://local/chat/stream'),
      {
        createSseClient: () => ({
          client: {
            send(event, data) {
              sent.push({ event, data });
            },
          },
          response,
        }),
        getLogLines: () => ['log-1'],
      },
    );

    expect(result).toBe(response);
    expect(sent).toEqual([
      { event: 'chat:init', data: { sessionState: 'idle' } },
      {
        event: 'chat:message-replay',
        data: {
          message: { id: 'm1', role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
          replayKind: 'cold-history',
        },
      },
      { event: 'chat:logs', data: { lines: ['log-1'] } },
      { event: 'chat:system-init', data: { info: { model: 'claude' } } },
      { event: 'chat:permission-request', data: { requestId: 'perm-1' } },
    ]);
  });

  it('ignores non-stream paths', async () => {
    await expect(handleChatStreamRoute(
      '/chat/send',
      new Request('http://local/chat/send'),
      {
        createSseClient: () => ({ client: { send: vi.fn() }, response: new Response() }),
        getLogLines: () => [],
      },
    )).resolves.toBeNull();
  });
});
