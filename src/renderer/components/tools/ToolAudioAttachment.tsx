/**
 * ToolAudioAttachment — large, card-style audio player for an `audio`
 * ToolAttachment (builtin edge-tts, Codex mcpToolCall audio). Mounted by
 * ToolAttachmentGallery in the message flow (PRD 0.2.30), redesigned in 0.2.31:
 *
 *   ┌───────────────────────────────────────────┐
 *   │ ▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭▭   ⋯ │  ← seek bar (top) + more menu
 *   │ 0:00                                  0:23 │  ← time
 *   │            ↺5    ▶/⏸    5↻                │  ← back-5s · play/pause · fwd-5s
 *   └───────────────────────────────────────────┘
 *
 * Playback reuses the global `audioPlayer.ts` singleton via `useAudioPlayer`
 * (one audio at a time), keyed on `savedPath` (the restart-safe trusted-root
 * copy). The "more" menu's open-path actions target `sourcePath` (the original
 * generated file the tool card advertises) so what's shown == what's opened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, FolderOpen, ExternalLink, Play, Pause, RotateCcw, RotateCw } from 'lucide-react';

import { useWorkspaceFileService } from '@/hooks/useWorkspaceFileService';
import { useFileAction } from '@/context/FileActionContext';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';
import { formatPlaybackTime } from '@/utils/audioPlayer';
import SeekBar from './SeekBar';
import type { ToolAttachment } from '../../../shared/types/tool-attachment';

interface Props {
  attachment: ToolAttachment;
}

const SKIP_SECONDS = 5;

export default function ToolAudioAttachment({ attachment }: Props) {
  const fileService = useWorkspaceFileService(null);
  // The chat's workspace root. `openPath` (sourcePath) may live under the
  // workspace (e.g. `<workspace>/myagents_files/...`) on a non-home drive
  // (`/Volumes/work`, `D:\`). Rust `validate_external_open_path` only allows
  // home/tmp/workspace prefixes, so without threading the workspace the menu
  // silently fails for workspaces outside `~`/`tmp`. FileActionContext already
  // carries it for the inline play button; reuse it (null outside Chat → home/tmp).
  const workspacePath = useFileAction()?.workspacePath ?? null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const savedPath = attachment.savedPath;
  // Playback uses the trusted-root copy; "open path" targets the ORIGINAL file.
  const openPath = attachment.sourcePath ?? attachment.savedPath;

  // Hook is called unconditionally (React rules); '' is never "current".
  const { isPlaying, isCurrent, toggle, progress, duration, seek } = useAudioPlayer(savedPath ?? '');

  const seekable = isCurrent && duration > 0;
  const skip = useCallback((delta: number) => {
    if (!seekable) return;
    seek(Math.max(0, Math.min(duration, progress + delta)));
  }, [seekable, seek, duration, progress]);

  // Close the overflow menu on any outside mousedown.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const reveal = useCallback(async () => {
    setMenuOpen(false);
    if (!openPath) return;
    try {
      await fileService.openPathExternal({ fullPath: openPath, workspace: workspacePath });
    } catch (err) {
      console.error('[ToolAudioAttachment] reveal failed:', err);
    }
  }, [fileService, openPath, workspacePath]);

  const openDefault = useCallback(async () => {
    setMenuOpen(false);
    if (!openPath) return;
    try {
      await fileService.openPathWithDefault({ fullPath: openPath, workspace: workspacePath });
    } catch (err) {
      console.error('[ToolAudioAttachment] open-with-default failed:', err);
    }
  }, [fileService, openPath, workspacePath]);

  // Placeholder (async save in flight — e.g. Codex audio).
  if (attachment.pendingId && !attachment.refPath) {
    return (
      <div className="flex h-14 w-full max-w-[460px] items-center rounded-xl border border-dashed border-[var(--paper-line)] bg-[var(--paper-inset)]/40 px-4 text-sm text-[var(--ink-muted)]">
        <span className="animate-pulse">音频生成中…</span>
      </div>
    );
  }

  // Error sentinel. (Optional-chain defensively against a partial object.)
  if (attachment.refPath?.startsWith('error://')) {
    return (
      <div className="flex h-14 w-full max-w-[460px] items-center rounded-xl border border-rose-300/50 bg-rose-50/30 px-4 text-xs text-rose-600 dark:bg-rose-900/10 dark:text-rose-300">
        <span>⚠️ 音频渲染失败：{attachment.refPath.slice('error://'.length)}</span>
      </div>
    );
  }

  const moreMenu = openPath ? (
    <div className="relative shrink-0" ref={menuRef}>
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
  ) : null;

  // No local path on this sidecar — degrade to a compact meta + menu row.
  if (!savedPath) {
    return (
      <div className="flex w-full max-w-[460px] items-center justify-between rounded-xl border border-[var(--paper-line)] bg-[var(--paper-inset)]/40 px-4 py-3 text-xs text-[var(--ink-muted)]">
        <span>音频</span>
        {moreMenu}
      </div>
    );
  }

  return (
    <div className="flex w-full max-w-[460px] flex-col gap-2 rounded-xl border border-[var(--paper-line)] bg-[var(--paper-inset)]/40 px-4 pt-3.5 pb-3">
      {/* Top: full-width seek bar + more menu */}
      <div className="flex items-center gap-2">
        <SeekBar
          ratio={seekable ? progress / duration : 0}
          seekable={seekable}
          onSeek={(r) => seek(r * duration)}
          className="flex-1"
        />
        {moreMenu}
      </div>

      {/* Time row */}
      <div className="flex justify-between text-[10px] tabular-nums text-[var(--ink-muted)]">
        <span>{isCurrent ? formatPlaybackTime(progress) : '0:00'}</span>
        <span>{seekable ? formatPlaybackTime(duration) : '--:--'}</span>
      </div>

      {/* Controls: back 5s · play/pause · forward 5s */}
      <div className="flex items-center justify-center gap-7 pt-0.5">
        <button
          type="button"
          aria-label="后退 5 秒"
          title="后退 5 秒"
          onClick={() => skip(-SKIP_SECONDS)}
          disabled={!seekable}
          className="relative flex size-9 items-center justify-center rounded-full text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-default disabled:opacity-35"
        >
          <RotateCcw className="size-5" />
          <span className="absolute text-[7px] font-semibold leading-none">5</span>
        </button>

        <button
          type="button"
          aria-label={isPlaying ? '暂停' : '播放'}
          onClick={toggle}
          className="flex size-12 items-center justify-center rounded-full bg-[var(--accent)] text-white shadow-sm transition-colors hover:bg-[var(--accent-warm-hover)]"
        >
          {isPlaying
            ? <Pause className="size-5 fill-current" />
            : <Play className="size-6 fill-current ml-0.5" />
          }
        </button>

        <button
          type="button"
          aria-label="前进 5 秒"
          title="前进 5 秒"
          onClick={() => skip(SKIP_SECONDS)}
          disabled={!seekable}
          className="relative flex size-9 items-center justify-center rounded-full text-[var(--ink-secondary)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-default disabled:opacity-35"
        >
          <RotateCw className="size-5" />
          <span className="absolute text-[7px] font-semibold leading-none">5</span>
        </button>
      </div>
    </div>
  );
}
