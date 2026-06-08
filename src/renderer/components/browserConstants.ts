// Sentinel URL for the empty browser ("new tab") state.
//
// Why a `data:` URL instead of `about:blank`: wry-0.54's `url_from_webview`
// unwraps WKWebView's `URL` property, which is nil for a freshly-created
// about:blank webview before its first load resolves. tao's
// `stop_app_on_panic` then escalates the runtime-thread panic to a process
// crash. A `data:` URL is its own URL — WKWebView's URL is populated the
// moment we hand it to `add_child`, so no internal accessor (ours, Tauri's,
// or wry's) can land in the nil-unwrap window.
//
// Lives in its own module so Chat.tsx can import the constant without
// statically pulling BrowserPanel into its chunk and defeating the
// `React.lazy()` split.
export const BROWSER_BLANK_URL = 'data:text/html;charset=utf-8,%3Chtml%3E%3C%2Fhtml%3E';

// Minimum container width/height (CSS px) before we let the OS-level browser
// webview be created or resized to match it.
//
// Why this guard exists (issue #290): the split panel's container is laid out
// behind a 300ms `transition-[width]` on the chat area. The instant the panel
// becomes visible the right-hand container is still ~0 px wide, so a naive
// `getBoundingClientRect()` read in the create effect captures `width: 0`. A
// webview born at width 0 — or a stray `resize(0,0,0,0)` from a transient
// display:none read — collapses the OS overlay and leaves it mis-positioned
// over the chat area instead of the right panel.
//
// Windows follow-up: during the same transition, WebView2 can see small but
// non-zero widths (1.1px, 24px, ...). Those are not usable browser geometry;
// creating/resizing the native child webview there seeds it with transition
// bounds before the final panel exists. Match TerminalPanel's transition guard
// and wait until the panel is at least meaningfully interactive.
const MIN_BROWSER_BOUNDS_PX = 100;

/**
 * True when a container's measured bounds are real enough to position the
 * native browser webview over them. Rejects 0/NaN/negative/tiny dimensions
 * that appear mid-transition or while the container is `display:none`.
 */
export function hasUsableBrowserBounds(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= MIN_BROWSER_BOUNDS_PX &&
    height >= MIN_BROWSER_BOUNDS_PX
  );
}
