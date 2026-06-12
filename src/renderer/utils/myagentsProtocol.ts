/**
 * Resolve app-owned custom-protocol subresource URLs for the current WebView.
 *
 * Tauri 2 serves custom protocols as `http://<scheme>.localhost/...` on
 * Windows, while macOS/Linux continue to use the scheme form. The Rust
 * `attachment_protocol` handler accepts both; renderer code must emit the form
 * the platform WebView can actually load as an <img>/<audio> subresource.
 */

const MYAGENTS_WINDOWS_ORIGIN = 'http://myagents.localhost';
const MYAGENTS_SCHEME_PREFIX = 'myagents://';

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
}

export function resolveMyAgentsProtocolUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (isWindowsPlatform()) {
    return `${MYAGENTS_WINDOWS_ORIGIN}${path}`;
  }
  return `${MYAGENTS_SCHEME_PREFIX}${path.slice(1)}`;
}
