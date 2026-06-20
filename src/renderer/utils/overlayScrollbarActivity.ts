const SCROLLBAR_ACTIVITY_CLASS = 'myagents-scrollbar-active';
const DEFAULT_IDLE_DELAY_MS = 850;

let installedCleanup: (() => void) | null = null;

export function isWindowsRendererPlatform(
  platform = typeof navigator !== 'undefined' ? navigator.platform : '',
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): boolean {
  return platform.toLowerCase().startsWith('win') || /\bWindows\b/i.test(userAgent);
}

export function shouldInstallOverlayScrollbarActivity(
  platform = typeof navigator !== 'undefined' ? navigator.platform : '',
  userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): boolean {
  return isWindowsRendererPlatform(platform, userAgent);
}

export function resolveScrollActivityElement(
  target: EventTarget | null,
  doc: Document = document,
): HTMLElement | null {
  const scrollingElement = (doc.scrollingElement as HTMLElement | null) ?? doc.documentElement;
  if (target === doc || target === doc.defaultView) return scrollingElement;

  const view = doc.defaultView;
  if (!view) return null;
  if (target instanceof view.HTMLElement) return target;
  if (target instanceof view.Element) return target.parentElement;
  return null;
}

export function installOverlayScrollbarActivity(options: {
  doc?: Document;
  win?: Window;
  platform?: string;
  userAgent?: string;
  idleDelayMs?: number;
} = {}): () => void {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const platform = options.platform;
  const userAgent = options.userAgent;
  if (!shouldInstallOverlayScrollbarActivity(platform, userAgent)) return () => {};
  if (installedCleanup) return installedCleanup;

  const idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
  const activeElements = new Set<HTMLElement>();
  const timers = new WeakMap<HTMLElement, number>();

  const clearElement = (element: HTMLElement) => {
    element.classList.remove(SCROLLBAR_ACTIVITY_CLASS);
    const timer = timers.get(element);
    if (timer !== undefined) {
      win.clearTimeout(timer);
      timers.delete(element);
    }
    activeElements.delete(element);
  };

  const markElement = (element: HTMLElement) => {
    element.classList.add(SCROLLBAR_ACTIVITY_CLASS);
    activeElements.add(element);
    const previousTimer = timers.get(element);
    if (previousTimer !== undefined) win.clearTimeout(previousTimer);
    const nextTimer = win.setTimeout(() => clearElement(element), idleDelayMs);
    timers.set(element, nextTimer);
  };

  const onScroll = (event: Event) => {
    const element = resolveScrollActivityElement(event.target, doc);
    if (!element) return;
    markElement(element);
  };

  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });

  installedCleanup = () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    for (const element of Array.from(activeElements)) {
      clearElement(element);
    }
    installedCleanup = null;
  };

  return installedCleanup;
}

export { SCROLLBAR_ACTIVITY_CLASS };
