import { describe, expect, it } from 'vitest';

import {
    createFloatingBallHoverIntentState,
    enterFloatingBallHover,
    leaveFloatingBallHover,
    suppressHoverPeekAfterBallClose,
} from './hoverIntent';

const ENABLED_GUARDS = {
    hoverEnabled: true,
    dragging: false,
    companionPinned: false,
};

describe('floating-ball hover intent', () => {
    it('starts peek only once for duplicate native and DOM enter signals', () => {
        const state = createFloatingBallHoverIntentState();

        expect(enterFloatingBallHover(state, ENABLED_GUARDS, 1000)).toBe(true);
        expect(enterFloatingBallHover(state, ENABLED_GUARDS, 1001)).toBe(false);
        expect(leaveFloatingBallHover(state)).toBe(true);
        expect(enterFloatingBallHover(state, ENABLED_GUARDS, 1002)).toBe(true);
    });

    it('suppresses hover reopen after closing pin from the ball', () => {
        const state = createFloatingBallHoverIntentState();

        suppressHoverPeekAfterBallClose(state, 1000, 500);
        expect(leaveFloatingBallHover(state)).toBe(true);

        expect(enterFloatingBallHover(state, ENABLED_GUARDS, 1100)).toBe(false);
        expect(leaveFloatingBallHover(state)).toBe(true);
        expect(enterFloatingBallHover(state, ENABLED_GUARDS, 1500)).toBe(true);
    });

    it('does not peek while the companion is already pinned', () => {
        const state = createFloatingBallHoverIntentState();

        expect(enterFloatingBallHover(state, { ...ENABLED_GUARDS, companionPinned: true }, 1000)).toBe(false);
        expect(leaveFloatingBallHover(state)).toBe(true);
        expect(enterFloatingBallHover(state, ENABLED_GUARDS, 1001)).toBe(true);
    });
});
