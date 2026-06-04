/**
 * AudioPlayerBar — compact, seekable audio player bar.
 *
 * Extracted from EdgeTtsTool (PRD 0.2.30) so both the legacy edge-tts card
 * (no-attachment history fallback) and the new ToolAudioAttachment renderer
 * share one player. Backed by the global `audioPlayer.ts` singleton via
 * `useAudioPlayer`, so only one audio plays at a time across the whole app.
 *
 * `filePath` is an absolute local path (e.g. the attachment savedPath or the
 * edge-tts generated_audio path). The singleton resolves it to a playable
 * source (Tauri: cmd_read_file_base64 → blob URL; browser: /api/audio).
 */
import { useRef, useCallback } from 'react';
import { Play, Square } from 'lucide-react';
import { track } from '@/analytics';
import { useAudioPlayer } from '@/hooks/useAudioPlayer';

function formatTime(sec: number): string {
  if (!sec || !isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function AudioPlayerBar({ filePath }: { filePath: string }) {
  const { isActive, toggle, progress, duration, seek } = useAudioPlayer(filePath);
  const trackedRef = useRef(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  // Track first play
  const handleToggle = useCallback(() => {
    if (!isActive && !trackedRef.current) {
      track('tts_play', {});
      trackedRef.current = true;
    }
    toggle();
  }, [isActive, toggle]);

  const displayProgress = isActive && duration > 0 ? progress / duration : 0;

  // Seek to position from mouse/pointer event
  const seekFromEvent = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el || !isActive || duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seek(ratio * duration);
  }, [isActive, duration, seek]);

  // Click to seek
  const handleTrackClick = useCallback((e: React.MouseEvent) => {
    seekFromEvent(e.clientX);
  }, [seekFromEvent]);

  // Drag to seek
  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!isActive || duration <= 0) return;
    e.preventDefault();
    draggingRef.current = true;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    seekFromEvent(e.clientX);
  }, [isActive, duration, seekFromEvent]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    seekFromEvent(e.clientX);
  }, [seekFromEvent]);

  const handlePointerUp = useCallback(() => {
    draggingRef.current = false;
  }, []);

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-[var(--paper-inset)] px-3 py-2 max-w-[400px]">
      {/* Play/Stop button */}
      <button
        type="button"
        onClick={handleToggle}
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-white transition-colors hover:bg-[var(--accent-warm-hover)]"
      >
        {isActive
          ? <Square className="size-2.5 fill-current" />
          : <Play className="size-3 fill-current ml-0.5" />
        }
      </button>

      {/* Seekable progress bar */}
      <div className="flex flex-1 items-center gap-2">
        <div
          ref={trackRef}
          className={`relative h-1.5 flex-1 rounded-full bg-[var(--line)] ${isActive ? 'cursor-pointer' : ''}`}
          onClick={handleTrackClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {/* Filled portion */}
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)]"
            // eslint-disable-next-line react-hooks/refs -- draggingRef read during render is intentional: transition must be instant while dragging to avoid lag
            style={{ width: `${displayProgress * 100}%`, transition: draggingRef.current ? 'none' : 'width 200ms' }}
          />
          {/* Thumb knob — only when active */}
          {isActive && (
            <div
              className="absolute top-1/2 -translate-y-1/2 size-3 rounded-full bg-[var(--accent)] shadow-sm ring-2 ring-white/80"
              style={{ left: `calc(${displayProgress * 100}% - 6px)` }}
            />
          )}
        </div>
        <span className="text-[10px] tabular-nums text-[var(--ink-muted)] shrink-0">
          {isActive ? formatTime(progress) : '0:00'} / {isActive && duration > 0 ? formatTime(duration) : '--:--'}
        </span>
      </div>
    </div>
  );
}
