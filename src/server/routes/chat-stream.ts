import { getSessionEngine } from '../session-engine';

type SseClient = {
  send(event: string, data: unknown): void;
};

export type ChatStreamRouteDeps = {
  createSseClient(onClose: () => void): { client: SseClient; response: Response };
  getLogLines(): string[];
};

export async function handleChatStreamRoute(
  pathname: string,
  request: Request,
  deps: ChatStreamRouteDeps,
): Promise<Response | null> {
  if (pathname !== '/chat/stream' || request.method !== 'GET') {
    return null;
  }

  // No onClose turn-interrupt: SSE disconnect is not a cancellation authority.
  const { client, response } = deps.createSseClient(() => {});
  const snapshot = getSessionEngine().getStreamReplaySnapshot();
  client.send('chat:init', snapshot.initState);

  for (const message of snapshot.replayMessages) {
    client.send('chat:message-replay', {
      message,
      replayKind: 'cold-history',
    });
  }

  client.send('chat:logs', { lines: deps.getLogLines() });

  if (snapshot.systemInitPayload) {
    client.send('chat:system-init', snapshot.systemInitPayload);
  }

  for (const pending of snapshot.pendingInteractiveRequests) {
    client.send(pending.type, pending.data);
  }

  return response;
}
