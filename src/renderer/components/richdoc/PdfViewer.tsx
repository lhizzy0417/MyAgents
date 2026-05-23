/**
 * PDF read-only viewer (pdf.js / pdfjs-dist).
 *
 * Renders pages to canvas with IntersectionObserver virtualization — only pages
 * scrolled near the viewport are rasterized (PRD 0.2.20 §5), so a 200-page
 * scanned contract doesn't pin memory. No text layer (read-only canvas; text
 * selection is an explicit non-goal, §9).
 *
 * Zoom is applied by scaling each page holder's dimensions NUMERICALLY (not via
 * CSS `zoom`): the canvas fills the holder via `width:100%`, so the holder's
 * pixel size sets the display size. This is load-bearing — CSS `zoom`/`transform`
 * on the observed content corrupts IntersectionObserver geometry, which made the
 * recycler clear visible pages → blank pages at non-100% zoom. With numeric
 * sizing the observer sees true geometry. Backing store stays at base×dpr, so
 * zoom-in is crisp up to ~2× (dpr≤2) and softens gracefully beyond.
 *
 * The page DOM is built imperatively (an island React doesn't manage) because
 * pdf.js renders into raw canvas elements; cleanup tears it down and cancels
 * in-flight render tasks.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import './pdfWorker';
import type { RichDocSubViewerProps } from './types';
import { useZoom, ZoomControls } from './zoom';

export default function PdfViewer({ bytes, onError, onEmpty }: RichDocSubViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const { zoom, zoomIn, zoomOut, reset } = useZoom(scrollRef);

  // Base (zoom=1) render width + page-1 aspect height, set during render and read
  // by the zoom effect to resize holders without re-rendering.
  const zoomRef = useRef(zoom);
  const baseWidthRef = useRef(0);
  const estHeightRef = useRef(0);

  // Resize existing holders when zoom changes — rendered canvases (width:100%)
  // scale with the holder; placeholders keep proportional scroll height. Also
  // mirrors zoom into the ref here (in an effect, not during render) for the
  // render-effect's holder sizing / recycle path.
  useEffect(() => {
    zoomRef.current = zoom;
    const content = contentRef.current;
    if (!content || !baseWidthRef.current) return;
    const w = baseWidthRef.current * zoom;
    const h = estHeightRef.current * zoom;
    content.querySelectorAll<HTMLElement>('[data-page]').forEach((holder) => {
      // Explicit width (not maxWidth+w-full) so zoom-in can exceed the container
      // and scroll horizontally; mx-auto centers when narrower.
      holder.style.width = `${w}px`;
      if (!holder.firstChild) holder.style.minHeight = `${h}px`;
    });
  }, [zoom]);

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
        canvas.style.width = '100%'; // display size set by holder (zoom-scaled)
        canvas.style.height = 'auto';
        holder.style.minHeight = '';
        holder.replaceChildren(canvas);
        // pdf.js v5: pass `canvas` (preferred over the legacy `canvasContext`).
        const task = page.render({
          canvas,
          viewport,
          // Read-only canvas preview — skip annotation operator parsing/drawing.
          annotationMode: pdfjsLib.AnnotationMode.DISABLE,
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
        if (pdf.numPages === 0) {
          onEmpty();
          return;
        }

        const width = Math.max(scroller.clientWidth - 32, 320);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);

        // Estimate placeholder height from page 1's aspect (most PDFs are uniform);
        // each page's actual render corrects its own height.
        const first = await pdf.getPage(1);
        const baseVp = first.getViewport({ scale: 1 });
        const estHeight = Math.round(width * (baseVp.height / baseVp.width));
        first.cleanup();
        if (cancelled) return; // cleanup will destroy the loading task

        baseWidthRef.current = width;
        estHeightRef.current = estHeight;

        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const holder = entry.target as HTMLElement;
              const pageNum = Number(holder.dataset.page);
              if (entry.isIntersecting) {
                void renderPage(pageNum, holder, width, dpr);
              } else if (rendered.has(pageNum) && holder.firstChild) {
                // Recycle off-screen page canvases — otherwise `rendered` grows
                // unbounded and a long/scanned PDF leaks tens of MB per page.
                // The 300px margin keeps this from thrashing on normal scrolling;
                // re-entering the viewport re-renders (fast, cached).
                holder.replaceChildren();
                holder.style.minHeight = `${estHeight * zoomRef.current}px`;
                rendered.delete(pageNum);
              }
            }
          },
          { root: scroller, rootMargin: '300px 0px' },
        );

        const z = zoomRef.current;
        const frag = document.createDocumentFragment();
        for (let n = 1; n <= pdf.numPages; n++) {
          const holder = document.createElement('div');
          holder.dataset.page = String(n);
          holder.style.width = `${width * z}px`;
          holder.style.minHeight = `${estHeight * z}px`;
          // `bg-white` is a deliberate design-token exemption: a PDF page is
          // physical white paper, and tinting it with --paper-* would distort the
          // rendered colors. Native viewers (Chrome/Preview) show white pages too.
          holder.className = 'mx-auto mb-3 bg-white shadow-sm';
          frag.appendChild(holder);
        }
        // Attach holders to the DOM FIRST, then observe. With an explicit `root`,
        // IntersectionObserver only reports a target that is a *descendant of the
        // root* at observe() time; observing holders while still in the detached
        // DocumentFragment meant WebKit never fired `isIntersecting`, so no page
        // ever rendered (blank). (pptx works because its renderer observes
        // already-attached slides.)
        const io = observer;
        content.replaceChildren(frag);
        content.querySelectorAll<HTMLElement>('[data-page]').forEach((holder) => io.observe(holder));
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
  }, [bytes, onError, onEmpty]);

  return (
    <div className="relative h-full overflow-hidden bg-[var(--paper-elevated)]">
      <div ref={scrollRef} className="h-full overflow-auto overscroll-contain p-4">
        <div ref={contentRef} />
      </div>
      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--ink-muted)]">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={reset} />
      )}
    </div>
  );
}
