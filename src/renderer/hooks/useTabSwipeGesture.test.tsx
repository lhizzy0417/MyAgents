import { cleanup, render, screen } from '@testing-library/react';
import { useRef, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Tab } from '@/types/tab';
import {
  clearFrontendLogs,
  getOriginalConsole,
  initFrontendLogger,
  restoreFrontendLogger,
  subscribeFrontendLogs,
} from '@/utils/frontendLogger';
import { useTabSwipeGesture } from './useTabSwipeGesture';

const tabs: Tab[] = [
  {
    id: 'tab-a',
    agentDir: null,
    sessionId: null,
    view: 'launcher',
    title: 'A',
    sidecarConfigDisposition: 'push',
  },
  {
    id: 'tab-b',
    agentDir: null,
    sessionId: null,
    view: 'launcher',
    title: 'B',
    sidecarConfigDisposition: 'push',
  },
];

const threeTabs: Tab[] = [
  ...tabs,
  {
    id: 'tab-c',
    agentDir: null,
    sessionId: null,
    view: 'launcher',
    title: 'C',
    sidecarConfigDisposition: 'push',
  },
];

function paneTestId(tabId: string): string {
  return `pane-${tabId.replace(/^tab-/, '')}`;
}

function Harness({
  onSwitchTab = vi.fn(),
  tabItems = tabs,
  initialActiveTabId = 'tab-a',
  children,
}: {
  onSwitchTab?: (tabId: string) => void;
  tabItems?: Tab[];
  initialActiveTabId?: string;
  children?: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const tabsRef = useRef<Tab[]>(tabItems);
  const activeTabIdRef = useRef<string | null>(initialActiveTabId);

  function handleSwitchTab(tabId: string) {
    activeTabIdRef.current = tabId;
    onSwitchTab(tabId);
  }

  useTabSwipeGesture({
    contentRef,
    tabsRef,
    activeTabIdRef,
    onSwitchTab: handleSwitchTab,
  });

  return (
    <div ref={contentRef} data-testid="tab-content">
      {tabItems.map((tab) => (
        <div
          key={tab.id}
          data-testid={paneTestId(tab.id)}
          className={tab.id === initialActiveTabId ? undefined : 'pointer-events-none invisible'}
          style={tab.id === initialActiveTabId ? undefined : { contentVisibility: 'hidden' }}
        >
          {tab.id === initialActiveTabId ? children : null}
        </div>
      ))}
    </div>
  );
}

function setContainerWidth(el: HTMLElement, width: number) {
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: width,
  });
}

function setHorizontalScrollMetrics(
  el: HTMLElement,
  metrics: { clientWidth: number; scrollWidth: number; scrollLeft: number },
) {
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: metrics.clientWidth,
  });
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    value: metrics.scrollWidth,
  });
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    writable: true,
    value: metrics.scrollLeft,
  });
}

function dispatchWheel(
  el: HTMLElement,
  init: WheelEventInit & { phase?: number; momentumPhase?: number },
): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.phase !== undefined) {
    Object.defineProperty(event, 'phase', { configurable: true, value: init.phase });
  }
  if (init.momentumPhase !== undefined) {
    Object.defineProperty(event, 'momentumPhase', { configurable: true, value: init.momentumPhase });
  }
  el.dispatchEvent(event);
  return event;
}

function phases(): string[] {
  return vi.mocked(console.debug).mock.calls
    .map(([line]) => String(line).match(/\bphase=([^ ]+)/)?.[1])
    .filter((phase): phase is string => Boolean(phase));
}

function debugLines(): string[] {
  return vi.mocked(console.debug).mock.calls.map(([line]) => String(line));
}

describe('useTabSwipeGesture Phase 0 trace', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    restoreFrontendLogger();
    clearFrontendLogs();
    vi.restoreAllMocks();
  });

  it('emits unified-log perf phases for a horizontal swipe sample', () => {
    render(<Harness />);
    const content = screen.getByTestId('tab-content');
    setContainerWidth(content, 1000);

    dispatchWheel(content, { deltaX: 120, deltaY: 2 });

    expect(phases()).toEqual(expect.arrayContaining([
      'tab_swipe_sample',
      'tab_swipe_direction_lock',
      'tab_swipe_begin',
      'tab_swipe_neighbor_prepare',
      'tab_swipe_update',
      'tab_swipe_idle_scheduled',
    ]));
  });

  it('logs zero-delta WebKit phase events before the existing early return', () => {
    const onSwitchTab = vi.fn();
    render(<Harness onSwitchTab={onSwitchTab} />);
    const content = screen.getByTestId('tab-content');
    setContainerWidth(content, 1000);

    dispatchWheel(content, { deltaX: 0, deltaY: 0, phase: 8 });

    expect(phases()).toEqual(expect.arrayContaining([
      'tab_swipe_sample',
      'tab_swipe_zero_delta_phase',
    ]));
    expect(phases()).not.toContain('tab_swipe_begin');
    expect(onSwitchTab).not.toHaveBeenCalled();
  });

  it('lets vertical direction lock expire instead of extending it with horizontal samples', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const content = screen.getByTestId('tab-content');
      setContainerWidth(content, 1000);

      const vertical = dispatchWheel(content, { deltaX: 1, deltaY: 30 });
      const deferredHorizontal = dispatchWheel(content, { deltaX: 80, deltaY: 0 });

      expect(vertical.defaultPrevented).toBe(false);
      expect(deferredHorizontal.defaultPrevented).toBe(false);
      expect(phases()).not.toContain('tab_swipe_begin');

      vi.advanceTimersByTime(151);

      const acceptedHorizontal = dispatchWheel(content, { deltaX: 80, deltaY: 0 });

      expect(acceptedHorizontal.defaultPrevented).toBe(true);
      expect(phases()).toEqual(expect.arrayContaining([
        'tab_swipe_direction_lock',
        'tab_swipe_begin',
        'tab_swipe_update',
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not switch tabs before release even when the drag crosses the threshold', () => {
    const onSwitchTab = vi.fn();
    render(<Harness onSwitchTab={onSwitchTab} />);
    const content = screen.getByTestId('tab-content');
    setContainerWidth(content, 1000);

    dispatchWheel(content, { deltaX: 600, deltaY: 0 });

    expect(phases()).not.toContain('tab_swipe_proactive_commit');
    expect(onSwitchTab).not.toHaveBeenCalled();
  });

  it('commits immediately when WebKit sends a zero-delta ended phase after tracking', () => {
    const onSwitchTab = vi.fn();
    render(<Harness onSwitchTab={onSwitchTab} />);
    const content = screen.getByTestId('tab-content');
    setContainerWidth(content, 1000);

    dispatchWheel(content, { deltaX: 400, deltaY: 0 });
    dispatchWheel(content, { deltaX: 0, deltaY: 0, phase: 8 });

    expect(phases()).toEqual(expect.arrayContaining([
      'tab_swipe_zero_delta_phase',
      'tab_swipe_release',
      'tab_swipe_decision',
      'tab_swipe_snap_start',
    ]));
    expect(onSwitchTab).toHaveBeenCalledWith('tab-b');
  });

  it('uses inferred momentum as release when WebKit does not expose phase events', () => {
    vi.useFakeTimers();
    try {
      const onSwitchTab = vi.fn();
      render(<Harness onSwitchTab={onSwitchTab} />);
      const content = screen.getByTestId('tab-content');
      setContainerWidth(content, 1000);

      for (const deltaX of [120, 100, 80, 64, 51, 41, 33, 26, 21, 17, 14, 11, 9, 7, 6, 5]) {
        dispatchWheel(content, { deltaX, deltaY: 0 });
        vi.advanceTimersByTime(16);
      }

      expect(onSwitchTab).toHaveBeenCalledTimes(1);
      expect(onSwitchTab).toHaveBeenCalledWith('tab-b');
      expect(phases()).toEqual(expect.arrayContaining([
        'tab_swipe_release',
        'tab_swipe_decision',
        'tab_swipe_snap_start',
      ]));
      expect(debugLines().some((line) => line.includes('source=momentum-detector'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('absorbs post-commit inertia without switching again after the active tab changes', () => {
    vi.useFakeTimers();
    try {
      const onSwitchTab = vi.fn();
      render(<Harness onSwitchTab={onSwitchTab} tabItems={threeTabs} />);
      const content = screen.getByTestId('tab-content');
      setContainerWidth(content, 1000);

      dispatchWheel(content, { deltaX: 400, deltaY: 0 });
      dispatchWheel(content, { deltaX: 0, deltaY: 0, phase: 8 });

      expect(onSwitchTab).toHaveBeenCalledTimes(1);
      expect(onSwitchTab).toHaveBeenCalledWith('tab-b');

      vi.advanceTimersByTime(400);

      const cooldownTail = dispatchWheel(content, { deltaX: 400, deltaY: 0, momentumPhase: 2 });
      expect(cooldownTail.defaultPrevented).toBe(true);
      expect(onSwitchTab).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(251);

      const lateMomentumTail = dispatchWheel(content, { deltaX: 400, deltaY: 0, momentumPhase: 2 });
      expect(lateMomentumTail.defaultPrevented).toBe(true);
      expect(onSwitchTab).toHaveBeenCalledTimes(1);
      expect(phases()).toEqual(expect.arrayContaining([
        'tab_swipe_cooldown_absorb',
        'tab_swipe_post_commit_momentum_absorb',
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a fresh non-momentum swipe after the shortened cooldown', () => {
    vi.useFakeTimers();
    try {
      const onSwitchTab = vi.fn();
      render(<Harness onSwitchTab={onSwitchTab} tabItems={threeTabs} />);
      const content = screen.getByTestId('tab-content');
      setContainerWidth(content, 1000);

      dispatchWheel(content, { deltaX: 400, deltaY: 0 });
      dispatchWheel(content, { deltaX: 0, deltaY: 0, phase: 8 });

      expect(onSwitchTab).toHaveBeenCalledTimes(1);
      expect(onSwitchTab).toHaveBeenCalledWith('tab-b');

      vi.advanceTimersByTime(700);

      const freshSwipe = dispatchWheel(content, { deltaX: 400, deltaY: 0 });
      dispatchWheel(content, { deltaX: 0, deltaY: 0, phase: 8 });

      expect(freshSwipe.defaultPrevented).toBe(true);
      expect(onSwitchTab).toHaveBeenCalledTimes(2);
      expect(onSwitchTab).toHaveBeenLastCalledWith('tab-c');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps nested horizontal scrollers native until they hit the edge', () => {
    render(
      <Harness>
        <div data-testid="inner-scroll" style={{ overflowX: 'auto' }} />
      </Harness>,
    );
    const content = screen.getByTestId('tab-content');
    const inner = screen.getByTestId('inner-scroll');
    setContainerWidth(content, 1000);
    setHorizontalScrollMetrics(inner, { clientWidth: 100, scrollWidth: 300, scrollLeft: 20 });

    const nativeScroll = dispatchWheel(inner, { deltaX: 80, deltaY: 0 });

    expect(nativeScroll.defaultPrevented).toBe(false);
    expect(phases()).not.toContain('tab_swipe_begin');

    setHorizontalScrollMetrics(inner, { clientWidth: 100, scrollWidth: 300, scrollLeft: 200 });

    const edgeHandoff = dispatchWheel(inner, { deltaX: 80, deltaY: 0 });

    expect(edgeHandoff.defaultPrevented).toBe(true);
    expect(phases()).toEqual(expect.arrayContaining([
      'tab_swipe_direction_relock',
      'tab_swipe_begin',
      'tab_swipe_update',
    ]));
  });

  it('routes trace lines through the frontend logger unified-log store', () => {
    vi.restoreAllMocks();
    clearFrontendLogs();
    const messages: string[] = [];
    const unsubscribe = subscribeFrontendLogs((entry) => {
      messages.push(entry.message);
    });
    const originalConsole = getOriginalConsole();
    const originalLog = originalConsole.log;
    const originalDebug = originalConsole.debug;
    originalConsole.log = vi.fn();
    originalConsole.debug = vi.fn();
    initFrontendLogger();

    try {
      render(<Harness />);
      const content = screen.getByTestId('tab-content');
      setContainerWidth(content, 1000);

      dispatchWheel(content, { deltaX: 120, deltaY: 2 });

      expect(messages.some((message) => message.includes('[perf] trace=renderer phase=tab_swipe_begin'))).toBe(true);
      expect(messages.some((message) => message.includes('[perf] trace=renderer phase=tab_swipe_update'))).toBe(true);
    } finally {
      cleanup();
      originalConsole.log = originalLog;
      originalConsole.debug = originalDebug;
      unsubscribe();
    }
  });
});
