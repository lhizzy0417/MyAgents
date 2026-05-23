/** Props every rich-doc sub-viewer receives from {@link RichDocViewer}. */
export interface RichDocSubViewerProps {
  /**
   * Decoded file bytes. The buffer is owned by RichDocViewer's state and is
   * stable per `path`. Viewers handing it to an API that *transfers/detaches*
   * the buffer (pdf.js `getDocument({ data })`) MUST `bytes.slice(0)` their own
   * copy first, so a re-run doesn't see a detached buffer.
   */
  bytes: ArrayBuffer;
  /** Report a fatal parse/render error up to RichDocViewer's unified error UI. */
  onError: (message: string) => void;
}
