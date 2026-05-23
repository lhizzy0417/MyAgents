/**
 * PDF read-only viewer (pdf.js / pdfjs-dist).
 *
 * Renders pages to canvas with IntersectionObserver virtualization — only pages
 * scrolled near the viewport are rasterized (PRD 0.2.20 §5), so a 200-page
 * scanned contract doesn't pin memory. No text layer (read-only canvas; text
 * selection is an explicit non-goal, §9).
 *
 * The page DOM is built imperatively (an island React doesn't manage) because
 * pdf.js renders into raw canvas elements; cleanup tears it down with the
 * wrapper and cancels in-flight render tasks.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import './pdfWorker';
import type { RichDocSubViewerProps } from './types';

export default function PdfViewer({ bytes, onError }: RichDocSubViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let pdf: PDFDocumentProxy | null = null;
    const renderTasks = new Set<RenderTask>();
    let observer: IntersectionObserver | null = null;
    const rendered = new Set<number>();

    const renderPage = async (pageNum: number, holder: HTMLElement, width: number, dpr: number) => {
      if (!Number.isFinite(pageNum) || rendered.has(pageNum) || cancelled || !pdf) return;
      rendered.add(pageNum);
      try {
        const page = await pdf.getPage(pageNum);
        if (cancelled) return;
        const scale = width / page.getViewport({ scale: 1 }).width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        if (!canvas.getContext('2d')) return;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        holder.style.minHeight = '';
        holder.replaceChildren(canvas);
        // pdf.js v5: pass `canvas` (preferred over the legacy `canvasContext`).
        const task = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTasks.add(task);
        await task.promise;
        renderTasks.delete(task);
        page.cleanup();
      } catch (e) {
        rendered.delete(pageNum); // allow retry when it re-enters the viewport
        if (e instanceof Error && e.name === 'RenderingCancelledException') return;
        // Per-page failures are non-fatal — leave the placeholder, keep scrolling.
      }
    };

    (async () => {
      try {
        // slice(0): pdf.js transfers the buffer into the worker and detaches it.
        // No `isEvalSupported` flag needed — the renderer CSP (`script-src 'self'`,
        // no `'unsafe-eval'`) already blocks eval, and pdf.js feature-detects this
        // and falls back automatically.
        loadingTask = pdfjsLib.getDocument({ data: bytes.slice(0) });
        pdf = await loadingTask.promise;
        if (cancelled) return; // cleanup will destroy the loading task

        const width = Math.max(scroller.clientWidth - 32, 320);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        // Estimate placeholder height from page 1's aspect (most PDFs are uniform);
        // each page's actual render corrects its own height.
        const first = await pdf.getPage(1);
        const baseVp = first.getViewport({ scale: 1 });
        const estHeight = Math.round(width * (baseVp.height / baseVp.width));
        first.cleanup();
        if (cancelled) return; // cleanup will destroy the loading task

        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const holder = entry.target as HTMLElement;
              void renderPage(Number(holder.dataset.page), holder, width, dpr);
            }
          },
          { root: scroller, rootMargin: '300px 0px' },
        );

        const frag = document.createDocumentFragment();
        for (let n = 1; n <= pdf.numPages; n++) {
          const holder = document.createElement('div');
          holder.dataset.page = String(n);
          holder.style.maxWidth = `${width}px`;
          holder.style.minHeight = `${estHeight}px`;
          // `bg-white` is a deliberate design-token exemption: a PDF page is
          // physical white paper, and tinting it with --paper-* would distort the
          // rendered colors. Native viewers (Chrome/Preview) show white pages too.
          holder.className = 'mx-auto mb-3 w-full bg-white shadow-sm';
          frag.appendChild(holder);
          observer.observe(holder);
        }
        content.replaceChildren(frag);
        setLoading(false);
      } catch (e) {
        if (!cancelled) onError(e instanceof Error ? e.message : 'PDF 渲染失败');
      }
    })();

    return () => {
      cancelled = true;
      observer?.disconnect();
      // pdf.js warns against destroy() during an active render — cancel all
      // in-flight render tasks, then destroy the loading task (which also
      // destroys the document) once they've settled.
      const pending = [...renderTasks].map((t) => t.promise.catch(() => {}));
      renderTasks.forEach((t) => t.cancel());
      void Promise.allSettled(pending).then(() => loadingTask?.destroy());
    };
  }, [bytes, onError]);

  return (
    <div ref={scrollRef} className="relative h-full overflow-auto overscroll-contain bg-[var(--paper-inset)] p-4">
      <div ref={contentRef} />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--ink-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
