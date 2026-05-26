import type { SessionMetadata } from '@/api/sessionClient';

const PREVIEW_MAX_LENGTH = 35;
const GENERIC_TITLES = new Set(['', 'New Chat', 'New Tab']);

function truncateDisplayText(raw: string): string {
  return raw.length <= PREVIEW_MAX_LENGTH
    ? raw
    : `${raw.slice(0, PREVIEW_MAX_LENGTH)}...`;
}

function stripSystemWrapper(raw: string): string {
  let text = raw.trim();
  if (!text) return '';

  if (text.startsWith('<system-reminder>')) {
    const closeTag = '</system-reminder>';
    const closeIdx = text.indexOf(closeTag);
    if (closeIdx >= 0) {
      const tail = text.slice(closeIdx + closeTag.length).trim();
      text = tail || text.slice('<system-reminder>'.length, closeIdx).trim();
    } else {
      text = text.slice('<system-reminder>'.length).trim();
    }
  }

  text = text
    .replace(/<\/?(?:CRON_TASK|HEARTBEAT|MEMORY_UPDATE)>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const taskTitle = text.match(/执行任务[:：]\s*#?\s*([^。；;\n]+)/);
  if (taskTitle?.[1]?.trim()) {
    return taskTitle[1].trim();
  }

  return text;
}

function normalizeCandidate(value: string | null | undefined): string {
  const stripped = stripSystemWrapper(value ?? '');
  if (GENERIC_TITLES.has(stripped)) return '';
  return stripped;
}

/**
 * Canonical session display policy for every session list and the Chat header:
 * usable title first; otherwise the last real user-message preview; otherwise
 * the product's empty-session title.
 */
export function getSessionDisplayText(session: Pick<SessionMetadata, 'title' | 'lastMessagePreview'>): string {
  const title = normalizeCandidate(session.title);
  if (title) return truncateDisplayText(title);

  const preview = normalizeCandidate(session.lastMessagePreview);
  if (preview) return truncateDisplayText(preview);

  return 'New Chat';
}
