// SearchPill — panel-header search input that grows on focus.
//
// Two width regimes:
//   • collapsed — compact pill (default 150px), visually lives as a
//     quiet "search available" affordance in the row
//   • expanded — wider input (default 320px, caller can override) that
//     appears when the user focuses the field or has a non-empty query
//
// The transition is a CSS `width` animation so the pill visibly "opens
// out" into a proper search box the moment the user commits to typing,
// then contracts back when blurred with nothing entered. This keeps the
// resting state scan-friendly without hiding the affordance behind an
// icon-button toggle (which was the PR1 pattern — it required a click
// just to reveal the input).

import { useState } from 'react';
import { Search, X } from 'lucide-react';
import type { RefObject } from 'react';

interface Props {
  /** Imperative ref so parents can focus the input via shortcut. */
  inputRef?: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  onClear?: () => void;
  placeholder?: string;
  /** Width when resting (empty + blurred). */
  collapsedPx?: number;
  /** Width when focused or when `value` is non-empty. */
  expandedPx?: number;
  /** When `true`, the expanded state takes the full width of its flex
   *  container instead of the `expandedPx` pixel value. Used by panel
   *  headers that collapse sibling content on focus so the search field
   *  can claim the whole row. The parent is responsible for hiding the
   *  sibling (e.g. the "想法" label). */
  expandedFull?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function SearchPill({
  inputRef,
  value,
  onChange,
  onClear,
  placeholder = '搜索…',
  collapsedPx = 150,
  expandedPx = 320,
  expandedFull = false,
  onFocus,
  onBlur,
}: Props) {
  const [focused, setFocused] = useState(false);
  // Focus OR a non-empty query both keep the pill expanded — so a
  // search-in-progress doesn't collapse and clip the query the moment
  // the user clicks a result.
  const expanded = focused || value.length > 0;
  const width = expanded
    ? expandedFull
      ? '100%'
      : `${expandedPx}px`
    : `${collapsedPx}px`;
  return (
    <div
      className="inline-flex h-7 items-center gap-1.5 rounded-full bg-[var(--paper-inset)] px-3 text-[var(--ink-muted)]"
      style={{
        width,
        transition: 'width 200ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
    >
      <Search className="h-3 w-3 shrink-0" strokeWidth={1.5} aria-hidden />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          setFocused(true);
          onFocus?.();
        }}
        onBlur={() => {
          setFocused(false);
          onBlur?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value && onClear) {
            e.preventDefault();
            onClear();
          }
        }}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-2sm text-[var(--ink)] placeholder:text-[var(--ink-muted)] focus:outline-none"
      />
      {value && onClear && (
        <button
          type="button"
          // mousedown, not click — the input's onBlur fires before click,
          // and the blur would collapse the pill AND hide the X button,
          // canceling the click. mousedown fires first and keeps focus
          // via preventDefault below.
          onMouseDown={(e) => {
            e.preventDefault();
            onClear();
          }}
          aria-label="清空搜索"
          className="shrink-0 rounded-full p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-elevated)] hover:text-[var(--ink)]"
        >
          <X className="h-3 w-3" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );
}

export default SearchPill;
