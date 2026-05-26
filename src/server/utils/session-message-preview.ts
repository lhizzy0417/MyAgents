import type { SessionMessage } from '../types/session';

export const CLIENT_MESSAGE_INLINE_MAX_BYTES = 256 * 1024;
const PREVIEW_HEAD_BYTES = 24 * 1024;
const PREVIEW_TAIL_BYTES = 8 * 1024;

function utf8Size(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sliceUtf8(value: string, maxBytes: number, fromEnd = false): string {
  if (maxBytes <= 0 || value.length === 0) return '';
  if (utf8Size(value) <= maxBytes) return value;

  let lo = 0;
  let hi = value.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = fromEnd ? value.slice(value.length - mid) : value.slice(0, mid);
    if (utf8Size(candidate) <= maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return fromEnd ? value.slice(value.length - best) : value.slice(0, best);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function shrinkSessionMessageForClient(message: SessionMessage): SessionMessage {
  const size = utf8Size(message.content);
  if (size <= CLIENT_MESSAGE_INLINE_MAX_BYTES) return message;

  const head = sliceUtf8(message.content, PREVIEW_HEAD_BYTES);
  const tail = sliceUtf8(message.content, PREVIEW_TAIL_BYTES, true);
  const omitted = Math.max(0, size - utf8Size(head) - utf8Size(tail));
  const content = [
    `This history message is too large for inline display and was truncated for the UI (original ${formatBytes(size)}, inline limit ${formatBytes(CLIENT_MESSAGE_INLINE_MAX_BYTES)}).`,
    'The complete content is still preserved in the local session file. Showing only the beginning and end avoids freezing history loading.',
    '',
    '--- Beginning ---',
    head,
    '',
    `--- Omitted ${formatBytes(omitted)} ---`,
    '',
    '--- End ---',
    tail,
  ].join('\n');

  return { ...message, content };
}

export function shrinkSessionMessagesForClient(messages: SessionMessage[]): SessionMessage[] {
  return messages.map(shrinkSessionMessageForClient);
}
