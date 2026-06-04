/**
 * ToolAudioAttachment — single audio attachment renderer (PRD 0.2.30).
 *
 * Owns the in-flow, card-style audio surface for any tool that emits an `audio`
 * ToolAttachment (builtin edge-tts, Codex mcpToolCall audio). Mounted by
 * ToolAttachmentGallery after the tool card, so the player lives in the
 * conversation flow rather than buried inside the collapsible tool body.
 *
 * Layout: [▶ player bar] + a compact meta line (format · size) + caption +
 * a "more" menu (reveal in file manager / open with default app).
 *
 * Playback reuses the global `audioPlayer.ts` singleton via AudioPlayerBar,
 * keyed on `savedPath` (absolute local path = the trusted-root copy).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, FolderOpen, ExternalLink } from 'lucide-react';

import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import AudioPlayerBar from './AudioPlayerBar';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachment: ToolAttachment;
}

function formatSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 'audio/mpeg' → 'MP3', 'audio/mp4' → 'M4A', fallback to subtype upper-cased. */
function formatLabel(mimeType: string): string {
  const sub = mimeType.split('/')[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = { mpeg: 'MP3', mp4: 'M4A', 'x-wav': 'WAV', wav: 'WAV', ogg: 'OGG', webm: 'WEBM', aac: 'AAC', opus: 'OPUS' };
  return map[sub] ?? (sub ? sub.toUpperCase() : 'AUDIO');
}

export default function ToolAudioAttachment({ attachment }: Props) {
  const fileService = useWorkspaceFileService(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the overflow menu on any outside mousedown.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const savedPath = attachment.savedPath;

  const reveal = useCallback(async () => {
    setMenuOpen(false);
    if (!savedPath) return;
    try {
      await fileService.openPathExternal({ fullPath: savedPath });
    } catch (err) {
      console.error('[ToolAudioAttachment] reveal failed:', err);
    }
  }, [fileService, savedPath]);

  const openDefault = useCallback(async () => {
    setMenuOpen(false);
    if (!savedPath) return;
    try {
      await fileService.openPathWithDefault({ fullPath: savedPath });
    } catch (err) {
      console.error('[ToolAudioAttachment] open-with-default failed:', err);
    }
  }, [fileService, savedPath]);

  // Placeholder (async save in flight — e.g. Codex audio).
  if (attachment.pendingId && !attachment.refPath) {
    return (
      <div className="flex h-12 w-full max-w-[400px] items-center rounded-lg border border-dashed border-[var(--paper-line)] bg-[var(--paper-inset)]/40 px-3 text-sm text-[var(--ink-muted)]">
        <span className="animate-pulse">音频生成中…</span>
      </div>
    );
  }

  // Error sentinel. (Optional-chain defensively: refPath is typed string, but a
  // partial/placeholder object shouldn't crash the message render.)
  if (attachment.refPath?.startsWith('error://')) {
    return (
      <div className="flex h-12 w-full max-w-[400px] items-center rounded-lg border border-rose-300/50 bg-rose-50/30 px-3 text-xs text-rose-600 dark:bg-rose-900/10 dark:text-rose-300">
        <span>⚠️ 音频渲染失败：{attachment.refPath.slice('error://'.length)}</span>
      </div>
    );
  }

  const format = formatLabel(attachment.mimeType);
  const size = formatSize(attachment.sizeBytes);
  const metaLine = [format, size].filter(Boolean).join(' · ');

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {savedPath ? (
          <AudioPlayerBar filePath={savedPath} />
        ) : (
          // No local path on this sidecar — degrade to a meta-only chip.
          <div className="flex h-9 items-center rounded-lg bg-[var(--paper-inset)] px-3 text-xs text-[var(--ink-muted)]">
            {format} 音频
          </div>
        )}
        {savedPath && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              aria-label="更多"
              onClick={() => setMenuOpen(o => !o)}
              className="flex size-7 items-center justify-center rounded-full text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink-secondary)]"
            >
              <MoreHorizontal className="size-4" />
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-8 z-50 min-w-[160px] overflow-hidden rounded-lg border border-[var(--paper-line)] bg-[var(--paper)] py-1 shadow-lg">
                <button
                  type="button"
                  onClick={reveal}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <FolderOpen className="size-3.5" /> 在文件管理器中显示
                </button>
                <button
                  type="button"
                  onClick={openDefault}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)]"
                >
                  <ExternalLink className="size-3.5" /> 用默认应用打开
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {(metaLine || attachment.caption) && (
        <div className="max-w-[400px] text-[10px] text-[var(--ink-muted)]">
          {metaLine && <span className="tabular-nums">{metaLine}</span>}
          {metaLine && attachment.caption && <span className="opacity-50"> · </span>}
          {attachment.caption && <span className="line-clamp-2">{attachment.caption}</span>}
        </div>
      )}
    </div>
  );
}
