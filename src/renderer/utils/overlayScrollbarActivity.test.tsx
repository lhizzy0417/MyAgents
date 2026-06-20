import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SCROLLBAR_ACTIVITY_CLASS,
  installOverlayScrollbarActivity,
  isWindowsRendererPlatform,
  resolveScrollActivityElement,
  shouldInstallOverlayScrollbarActivity,
} from './overlayScrollbarActivity';

describe('overlayScrollbarActivity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('installs only on Windows platforms', () => {
    expect(shouldInstallOverlayScrollbarActivity('Win32')).toBe(true);
    expect(shouldInstallOverlayScrollbarActivity('MacIntel')).toBe(false);
    expect(shouldInstallOverlayScrollbarActivity('Linux x86_64')).toBe(false);
    expect(shouldInstallOverlayScrollbarActivity('Darwin')).toBe(false);
    expect(shouldInstallOverlayScrollbarActivity('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
  });

  it('uses exact Windows platform detection for shared platform classes', () => {
    expect(isWindowsRendererPlatform('Win32', '')).toBe(true);
    expect(isWindowsRendererPlatform('Darwin', '')).toBe(false);
    expect(isWindowsRendererPlatform('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(false);
    expect(isWindowsRendererPlatform('', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(true);
  });

  it('maps document scroll events to the document element', () => {
    expect(resolveScrollActivityElement(document, document)).toBe(document.documentElement);
  });

  it('marks a scroller active during scroll and clears it after idle', () => {
    vi.useFakeTimers();
    const cleanup = installOverlayScrollbarActivity({
      doc: document,
      win: window,
      platform: 'Win32',
      idleDelayMs: 50,
    });
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller).toHaveClass(SCROLLBAR_ACTIVITY_CLASS);

    vi.advanceTimersByTime(49);
    expect(scroller).toHaveClass(SCROLLBAR_ACTIVITY_CLASS);
    vi.advanceTimersByTime(1);
    expect(scroller).not.toHaveClass(SCROLLBAR_ACTIVITY_CLASS);

    cleanup();
    scroller.remove();
  });

  it('keeps a scroller active until the latest scroll goes idle', () => {
    vi.useFakeTimers();
    const cleanup = installOverlayScrollbarActivity({
      doc: document,
      win: window,
      platform: 'Win32',
      idleDelayMs: 50,
    });
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(30);
    scroller.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(49);
    expect(scroller).toHaveClass(SCROLLBAR_ACTIVITY_CLASS);
    vi.advanceTimersByTime(1);
    expect(scroller).not.toHaveClass(SCROLLBAR_ACTIVITY_CLASS);

    cleanup();
    scroller.remove();
  });

  it('does not mark scrollbars on non-Windows platforms', () => {
    const cleanup = installOverlayScrollbarActivity({
      doc: document,
      win: window,
      platform: 'MacIntel',
      idleDelayMs: 50,
    });
    const scroller = document.createElement('div');
    document.body.appendChild(scroller);

    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller).not.toHaveClass(SCROLLBAR_ACTIVITY_CLASS);

    cleanup();
    scroller.remove();
  });
});
