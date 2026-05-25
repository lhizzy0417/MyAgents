// Regression test for the "phantom repeated rows + blank viewport" Virtuoso
// corruption (2026-05-25, /cross-bugfix).
//
// Root cause: while a tab is inactive the host wraps the list in
// `content-visibility:hidden`; WebKit skips its layout, so any data/height churn
// Virtuoso processes in that state poisons its offset/range cache. The streaming
// reveal loop kept growing the last row while hidden. The fix freezes the
// `data`/`firstItemIndex` handed to Virtuoso while `!isActive`, so no measurement
// churn reaches it; on re-activation we swap back to the live array.
//
// This test pins that invariant at the Virtuoso boundary: it captures the `data`
// / `firstItemIndex` props Virtuoso receives and asserts they stay frozen while
// inactive and resume live on re-activation.
import { render } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

// ── Capture the props handed to Virtuoso on every render ──
type Recorded = { data: MessageType[]; firstItemIndex: number | undefined };
const recorded: Recorded[] = [];
vi.mock('react-virtuoso', () => ({
  Virtuoso: (props: { data: MessageType[]; firstItemIndex?: number }) => {
    recorded.push({ data: props.data, firstItemIndex: props.firstItemIndex });
    return <div data-testid="virtuoso" data-count={props.data.length} />;
  },
}));

// Heavy children — stub so jsdom doesn't pull Markdown / tool / prompt trees.
vi.mock('@/components/Message', () => ({ default: () => <div data-testid="msg" /> }));
vi.mock('@/components/PermissionPrompt', () => ({ PermissionPrompt: () => null }));
vi.mock('@/components/AskUserQuestionPrompt', () => ({ AskUserQuestionPrompt: () => null }));
vi.mock('@/components/ExitPlanModePrompt', () => ({ ExitPlanModePrompt: () => null }));

import MessageList from './MessageList';

function msg(id: string, content: string, role: 'user' | 'assistant' = 'assistant'): MessageType {
  return { id, role, content, timestamp: new Date() } as MessageType;
}

function renderList(overrides: Partial<React.ComponentProps<typeof MessageList>>) {
  const props: React.ComponentProps<typeof MessageList> = {
    historyMessages: [],
    streamingMessage: null,
    isLoading: false,
    sessionId: 's1',
    isActive: true,
    firstItemIndex: 1_000_000,
    virtuosoRef: { current: null },
    followEnabledRef: { current: true },
    scrollToBottom: vi.fn(),
    handleAtBottomChange: vi.fn(),
    ...overrides,
  };
  return render(<MessageList {...props} />);
}

const lastData = () => recorded[recorded.length - 1];
const streamingText = (r: Recorded) => {
  const last = r.data[r.data.length - 1];
  return typeof last?.content === 'string' ? last.content : '';
};

describe('MessageList — freeze data while inactive (Virtuoso cache-poisoning regression)', () => {
  beforeEach(() => { recorded.length = 0; });

  it('does NOT forward streaming growth to Virtuoso while inactive, and resumes live on re-activation', () => {
    const history = [msg('h1', 'hello', 'user'), msg('h2', 'hi there')];

    // 1. Active, streaming "a".
    const { rerender } = renderList({
      historyMessages: history,
      streamingMessage: msg('stream', 'a'),
      isLoading: true,
      isActive: true,
    });
    expect(streamingText(lastData())).toBe('a');

    // 2. Go inactive (content-visibility:hidden). The reveal loop keeps growing the
    //    streaming row — emulate by re-rendering with a longer streaming message.
    rerender(
      <MessageList
        historyMessages={history}
        streamingMessage={msg('stream', 'abc')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        followEnabledRef={{ current: true }}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    // FROZEN: Virtuoso must still see the pre-hidden snapshot ("a"), not "abc".
    expect(streamingText(lastData())).toBe('a');

    // 3. More growth while still hidden → still frozen.
    rerender(
      <MessageList
        historyMessages={history}
        streamingMessage={msg('stream', 'abcdef')}
        isLoading isActive={false}
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        followEnabledRef={{ current: true }}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('a');

    // 4. Re-activate → Virtuoso swaps to the live (grown) array.
    rerender(
      <MessageList
        historyMessages={history}
        streamingMessage={msg('stream', 'abcdefghi')}
        isLoading isActive
        firstItemIndex={1_000_000}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        followEnabledRef={{ current: true }}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(streamingText(lastData())).toBe('abcdefghi');
  });

  it('does NOT carry a stale "scrolled-up" follow snapshot across a session switch made while hidden', () => {
    // Repro: user scrolls up in session s1, switches tab away (snapshot=false@s1),
    // the tab's session is switched to s2 while hidden, then user returns. The old
    // s1 "don't follow" intent must NOT disable follow for the fresh s2 — otherwise
    // s2 loads at bottom but never auto-scrolls new streaming.
    const followRef: { current: boolean | 'force' } = { current: true };
    // Realistic scrollToBottom: mirrors the hook by flipping the ref to 'force'.
    const scrollToBottom = vi.fn(() => { followRef.current = 'force'; });

    const s1 = [msg('a1', 'x', 'user'), msg('a2', 'y')];
    const { rerender } = renderList({
      sessionId: 's1', historyMessages: s1, isActive: true,
      followEnabledRef: followRef, scrollToBottom,
    });

    // User scrolls up in s1 → follow disabled.
    followRef.current = false;

    // Switch tab away → inactive snapshot captures (false @ s1).
    rerender(
      <MessageList
        sessionId="s1" historyMessages={s1} streamingMessage={null}
        isLoading={false} isActive={false} firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} followEnabledRef={followRef}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // Session switched to s2 while still hidden, then user returns (isActive=true).
    const s2 = [msg('b1', 'p', 'user'), msg('b2', 'q')];
    rerender(
      <MessageList
        sessionId="s2" historyMessages={s2} streamingMessage={null}
        isLoading={false} isActive firstItemIndex={1_000_000}
        virtuosoRef={{ current: null }} followEnabledRef={followRef}
        scrollToBottom={scrollToBottom} handleAtBottomChange={vi.fn()}
      />,
    );

    // The stale s1 "false" must have been dropped: s2 ends up following, not disabled.
    expect(followRef.current).not.toBe(false);
  });

  it('freezes firstItemIndex while inactive (no prepend anchor drift mid-hide)', () => {
    const history = [msg('h1', 'a', 'user'), msg('h2', 'b')];
    const { rerender } = renderList({
      historyMessages: history,
      isActive: true,
      firstItemIndex: 1_000_000,
    });
    expect(lastData().firstItemIndex).toBe(1_000_000);

    // Inactive: even if a stray prepend decrements firstItemIndex, Virtuoso keeps the snapshot.
    rerender(
      <MessageList
        historyMessages={history}
        streamingMessage={null}
        isLoading={false} isActive={false}
        firstItemIndex={999_995}
        sessionId="s1"
        virtuosoRef={{ current: null }}
        followEnabledRef={{ current: true }}
        scrollToBottom={vi.fn()}
        handleAtBottomChange={vi.fn()}
      />,
    );
    expect(lastData().firstItemIndex).toBe(1_000_000);
  });
});
