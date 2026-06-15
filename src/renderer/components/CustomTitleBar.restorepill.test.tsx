// Behavior test for the "恢复对话" pill (Issue #309). The pill is opt-in
// session restore surfaced in the title bar only after a non-clean exit. We
// mock the Tauri-heavy deps (effects bail when isTauri() is false) and assert
// the pill's visibility gate + click wiring.
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/api/tauriClient', () => ({ isTauri: () => false }));
vi.mock('./FeedbackPopover', () => ({ default: () => null }));

import CustomTitleBar from './CustomTitleBar';

function renderBar(over: Partial<React.ComponentProps<typeof CustomTitleBar>> = {}) {
    const onRestoreSession = vi.fn();
    const onDismissRestore = vi.fn();
    const result = render(
        <CustomTitleBar
            onRestoreSession={onRestoreSession}
            onDismissRestore={onDismissRestore}
            {...over}
        >
            <div data-testid="tabbar" />
        </CustomTitleBar>,
    );
    return { ...result, onRestoreSession, onDismissRestore };
}

describe('CustomTitleBar — 恢复对话 pill (Issue #309)', () => {
    it('is hidden when restoreCount is 0 (clean quit → no nag)', () => {
        renderBar({ restoreCount: 0 });
        expect(screen.queryByText('恢复上次对话')).toBeNull();
    });

    it('shows the pill and the count badge when there are restorable tabs', () => {
        renderBar({ restoreCount: 3 });
        expect(screen.getByText('恢复上次对话')).toBeTruthy();
        expect(screen.getByText('3')).toBeTruthy();
    });

    it('omits the count badge for a single conversation', () => {
        renderBar({ restoreCount: 1 });
        expect(screen.getByText('恢复上次对话')).toBeTruthy();
        expect(screen.queryByText('1')).toBeNull();
    });

    it('restores on body click, dismisses on ✕ click', () => {
        const { onRestoreSession, onDismissRestore } = renderBar({ restoreCount: 2 });

        fireEvent.click(screen.getByText('恢复上次对话'));
        expect(onRestoreSession).toHaveBeenCalledTimes(1);
        expect(onDismissRestore).not.toHaveBeenCalled();

        fireEvent.click(screen.getByTitle('忽略'));
        expect(onDismissRestore).toHaveBeenCalledTimes(1);
        expect(onRestoreSession).toHaveBeenCalledTimes(1);
    });

    it('keeps explicit draggable regions around and between titlebar actions', () => {
        const { container } = renderBar({ restoreCount: 0 });
        const dragRegions = Array.from(container.querySelectorAll('[data-tauri-drag-region]'));
        const tabbarHost = screen.getByTestId('tabbar').parentElement;

        expect(dragRegions.length).toBeGreaterThanOrEqual(4);
        expect(dragRegions.some((node) => (node as HTMLElement).style.width === '30px')).toBe(true);
        expect(dragRegions.some((node) => (node as HTMLElement).className.includes('w-1'))).toBe(true);
        expect(tabbarHost?.className).toContain('flex-1');
    });
});
