import type { SessionMetadata } from '@/api/sessionClient';
// Canonical wrapper-stripper shared with the sidecar storage layer (cron-title
// fix) so the display and persistence paths can never drift.
import { stripSystemWrapper, capWithEllipsis } from '../../shared/sessionTitle';

const PREVIEW_MAX_LENGTH = 35;
const GENERIC_TITLES = new Set(['', 'New Chat', 'New Tab']);

function truncateDisplayText(raw: string): string {
  return capWithEllipsis(raw, PREVIEW_MAX_LENGTH);
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
