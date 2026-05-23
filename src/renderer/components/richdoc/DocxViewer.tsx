/**
 * DOCX read-only viewer (docx-preview).
 *
 * `renderAsync` parses the OOXML and builds a high-fidelity, paginated DOM
 * (styles / tables / images / headers / footers) directly via DOM APIs — no
 * arbitrary-HTML injection, so XSS surface is small.
 *
 * Two options harden privacy (PRD §6.2 / acceptance #10 — zero network egress):
 *  - `renderAltChunks: false` — altChunks render into an `<iframe srcdoc>` whose
 *    inner DOM the host's externalResourceGuard cannot observe; disabling it
 *    removes that bypass entirely.
 *  - `useBase64URL: true` — embedded images become inline `data:` URLs instead of
 *    `URL.createObjectURL` blobs, so there are no blob URLs to leak on unmount.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { renderAsync } from 'docx-preview';
import type { RichDocSubViewerProps } from './types';

export default function DocxViewer({ bytes, onError }: RichDocSubViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    container.replaceChildren();

    // Blob copies the bytes, so the shared buffer is never detached.
    renderAsync(new Blob([bytes]), container, undefined, {
      className: 'docx',
      inWrapper: true,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      ignoreLastRenderedPageBreak: true,
      renderAltChunks: false, // no <iframe srcdoc> — closes a guard bypass
      useBase64URL: true, // inline data: images — no blob URLs to leak
    })
      .then(() => {
        if (!cancelled) setLoading(false);
      })
      .catch((e) => {
        if (!cancelled) onError(e instanceof Error ? e.message : 'Word 文档渲染失败');
      });

    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [bytes, onError]);

  return (
    <div className="relative h-full overflow-auto overscroll-contain bg-[var(--paper-inset)] p-4">
      <div ref={containerRef} className="mx-auto" />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--ink-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
