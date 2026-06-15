export interface FloatingBallHoverIntentState {
    inside: boolean;
    suppressUntilLeave: boolean;
    suppressPeekUntil: number;
}

export interface FloatingBallHoverGuards {
    hoverEnabled: boolean;
    dragging: boolean;
    companionPinned: boolean;
}

export function createFloatingBallHoverIntentState(): FloatingBallHoverIntentState {
    return {
        inside: false,
        suppressUntilLeave: false,
        suppressPeekUntil: 0,
    };
}

export function resetFloatingBallHoverIntent(state: FloatingBallHoverIntentState): void {
    state.inside = false;
    state.suppressUntilLeave = false;
    state.suppressPeekUntil = 0;
}

export function suppressHoverPeekAfterBallClose(
    state: FloatingBallHoverIntentState,
    now: number,
    cooldownMs: number,
): void {
    state.inside = true;
    state.suppressUntilLeave = true;
    state.suppressPeekUntil = Math.max(state.suppressPeekUntil, now + cooldownMs);
}

export function enterFloatingBallHover(
    state: FloatingBallHoverIntentState,
    guards: FloatingBallHoverGuards,
    now: number,
): boolean {
    if (state.inside) return false;
    state.inside = true;
    if (
        !guards.hoverEnabled ||
        guards.dragging ||
        guards.companionPinned ||
        state.suppressUntilLeave ||
        now < state.suppressPeekUntil
    ) {
        return false;
    }
    return true;
}

export function leaveFloatingBallHover(state: FloatingBallHoverIntentState): boolean {
    const wasInside = state.inside;
    state.inside = false;
    state.suppressUntilLeave = false;
    return wasInside;
}
