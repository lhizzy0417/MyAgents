import {
  normalizeChatQueueResponseMode,
  type ChatQueueResponseMode,
} from '../shared/config-types';

export type QueueAdmissionAction =
  | 'direct'
  | 'realtime-inflight'
  | 'realtime-buffer'
  | 'turn-boundary';

export function shouldApplyChatQueueResponseMode(
  fromDesktopChatSend: boolean | undefined,
): boolean {
  return fromDesktopChatSend === true;
}

export function resolveChatQueueResponseMode(
  rawValue: unknown,
  fromDesktopChatSend: boolean | undefined,
): ChatQueueResponseMode {
  if (!shouldApplyChatQueueResponseMode(fromDesktopChatSend)) return 'realtime';
  return normalizeChatQueueResponseMode(rawValue);
}

export function decideQueueAdmission(params: {
  mode: ChatQueueResponseMode;
  busy: boolean;
  hasInFlight: boolean;
  hasScopedTurnBoundaryQueued?: boolean;
}): QueueAdmissionAction {
  if (!params.busy) return 'direct';
  if (params.hasScopedTurnBoundaryQueued) return 'turn-boundary';
  if (params.mode === 'turn') return 'turn-boundary';
  return params.hasInFlight ? 'realtime-buffer' : 'realtime-inflight';
}
