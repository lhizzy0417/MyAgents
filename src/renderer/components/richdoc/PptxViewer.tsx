/**
 * PowerPoint read-only viewer (@aiden0z/pptx-renderer) — `.pptx` only.
 *
 * Renders slides as a scrollable list with windowed (virtualized) mounting so
 * only on-screen slides are built. Media is resolved from the pptx zip to
 * blob/data URLs; the host's external-resource guard covers any external ref.
 *
 * Fidelity ceiling (PRD §9): no animations / 3D / OLE / EMF-WMF. Static layout
 * only. Legacy binary `.ppt` is not supported by any pure-frontend renderer and
 * is out of scope (stays on "open with default app").
 *
 * NOTE (CSP): pptx-renderer internally tries an off-main-thread decoder via a
 * `blob:` Worker. The renderer CSP (`script-src 'self'`, no `blob:`) blocks that
 * worker, but the library fails safe (try/catch → falls back on the main thread)
 * so slides still render — only the worker-accelerated path (EMF/WMF-class, which
 * we already don't support per §9) is skipped. We deliberately keep CSP unchanged.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { PptxViewer as PptxRenderer } from '@aiden0z/pptx-renderer';
import './pdfWorker'; // pptx-renderer peerDeps pdfjs-dist (embedded PDF objects)
import type { RichDocSubViewerProps } from './types';

export default function PptxViewer({ bytes, onError }: RichDocSubViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;

    let disposed = false;
    // Construct the viewer synchronously (so cleanup can stop it even mid-open),
    // then drive the async open with an AbortSignal — on unmount/file-switch we
    // abort the in-flight parser/render batch instead of letting it run to
    // completion. slice(0): hand the renderer its own buffer, never the shared one.
    const ac = new AbortController();
    const viewer = new PptxRenderer(content, {
      scrollContainer: scroll,
      fitMode: 'contain',
    });

    viewer
      .open(bytes.slice(0), {
        renderMode: 'list',
        listOptions: { windowed: true, showSlideLabels: true },
        signal: ac.signal,
      })
      .then(() => {
        if (!disposed) setLoading(false);
      })
      .catch((e) => {
        if (!disposed && !ac.signal.aborted) {
          onError(e instanceof Error ? e.message : '演示文稿渲染失败');
        }
      });

    return () => {
      disposed = true;
      ac.abort();
      viewer.destroy();
    };
  }, [bytes, onError]);

  return (
    <div ref={scrollRef} className="relative h-full overflow-auto overscroll-contain bg-[var(--paper-inset)] p-4">
      <div ref={contentRef} className="mx-auto" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--ink-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
