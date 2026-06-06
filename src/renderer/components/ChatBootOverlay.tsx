import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Fade-out duration on dismiss (ms). Kept a hair longer than the CSS
 *  `duration-300` so the element unmounts only after the fade visually completes. */
const FADE_OUT_MS = 320;

/**
 * Unified "AI 启动中" boot overlay — the frosted-glass loading state shown from the
 * instant a chat is entered (Launcher→Chat) until the session is ready.
 *
 * Rendered in TWO phases so the whole entry is ONE continuous loading state:
 *   1. App's Suspense fallback while the lazy Chat chunk resolves (before mount) —
 *      replaces the old blank paper div that read as "nothing happened".
 *   2. Chat's in-page overlay during the sidecar cold boot (after mount), driven by
 *      the `show` prop.
 *
 * Dismiss is ANIMATED: when `show` clears, the overlay lingers one transition,
 * fading opacity 1→0, then unmounts — so the chat (already mounted underneath this
 * z-30 layer) reveals softly instead of cutting in. APPEARANCE is instant (no
 * fade-in — that would defeat instant-nav): it mounts at opacity-100 and the
 * transition only animates the subsequent change to opacity-0.
 */
export default function ChatBootOverlay({ show = true }: { show?: boolean }) {
    // Stays mounted while shown; on dismiss, linger one fade then unmount. Initialised
    // from `show` (the overlay is shown from the first render — it never re-arms within
    // a mount, so no enter-side setState is needed). The leave's setState lives in the
    // timeout callback, not directly in the effect.
    const [mounted, setMounted] = useState(show);
    useEffect(() => {
        if (show) return; // still showing — nothing to schedule
        const t = setTimeout(() => setMounted(false), FADE_OUT_MS);
        return () => clearTimeout(t);
    }, [show]);

    if (!mounted) return null;

    return (
        <div
            className={`absolute inset-0 z-30 flex items-center justify-center bg-[var(--paper)]/80 backdrop-blur-sm transition-opacity duration-300 ease-out ${show ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        >
            <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                <p className="text-sm text-[var(--ink-muted)]">AI 启动中</p>
            </div>
        </div>
    );
}
