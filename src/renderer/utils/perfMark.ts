/**
 * Minimal dev/diagnostics performance marks. No-op unless enabled, so call sites
 * are safe to leave in production. Enabled in the Vite dev build, or when
 * `localStorage['myagents:perf'] === '1'` (lets us profile a production build).
 *
 * Currently used to quantify the Task Center SWR-cache win — cache-hit vs
 * cache-miss mount and time-to-data-ready (P0-0 measurement, see
 * specs/research/0605_research_frontend_perf_architecture_deep_review.md §10).
 * Inspect in the browser/devtools Performance panel by name.
 */

/** Pure gating decision — unit-tested directly (env/localStorage injected). */
export function isPerfEnabled(isDev: boolean, lsGet: (key: string) => string | null): boolean {
    if (isDev) return true;
    try {
        return lsGet('myagents:perf') === '1';
    } catch {
        return false;
    }
}

const ENABLED = isPerfEnabled(
    Boolean(import.meta.env?.DEV),
    (key) => (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null),
);

export function perfMark(name: string): void {
    if (!ENABLED) return;
    if (typeof performance === 'undefined' || typeof performance.mark !== 'function') return;
    try {
        performance.mark(name);
    } catch {
        // best-effort diagnostics — never throw into a render path
    }
}

export function perfMeasure(name: string, startMark: string, endMark: string): void {
    if (!ENABLED) return;
    if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return;
    try {
        performance.measure(name, startMark, endMark);
    } catch {
        // ignore — e.g. a start mark that never fired
    }
}
