import { resolve } from 'path';
import { defineConfig } from 'vitest/config';

const alias = { '@': resolve(__dirname, 'src/renderer') };

// Two test projects, split by what a test TOUCHES — so the dev loop gets a
// fast, parallel pure-logic pool while the stateful integration-ish tests keep
// their (required) serial isolation.
//
//  - `unit`     : pure logic. No module-level singletons, no fixed ports, no
//                 real SDK, no shared disk path → safe to run in PARALLEL forks.
//                 Target: < 5s, run on every save (`npm run test:unit`).
//  - `stateful` : touches `agent-session.ts` / `index.ts` / `external-session.ts`
//                 module-level globals, binds a sidecar port, writes under
//                 ~/.myagents, or runs the real SDK. MUST stay singleFork serial
//                 (the original reason vitest was configured singleFork).
//
// Routing rule: shared/* and renderer/* are pure today (DOM-free util/service
// tests under node env) → `unit`. Server tests default to `stateful`; a NEW
// pure server test opts INTO the fast pool by naming itself `*.unit.test.ts`.
// If a `unit` test ever flakes under parallelism (turns out to import a stateful
// module), move it to `stateful` — correctness over speed.
//
// The `dom` project runs `*.test.tsx` in jsdom with @testing-library/react for
// component / hook behaviour (focus, events, rendering). Component tests that
// need canvas / real WebView (pdf.js render, etc.) are out of scope for jsdom —
// extract their pure logic and test that in `unit` instead.
export default defineConfig({
  resolve: { alias },
  test: {
    // Coverage is aggregated across projects. No hard % threshold on purpose —
    // we ratchet per changed file rather than chase a global number (which
    // invites filler tests). Run with `npm run coverage`.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'json-summary'],
      include: ['src/**'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/**/__tests__/**', 'src/test/**'],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: [
            'src/shared/**/*.test.ts',
            'src/renderer/**/*.test.ts',
            'src/server/**/*.unit.test.ts',
          ],
          // Fast pure tests — a tight timeout surfaces accidental real I/O.
          testTimeout: 10_000,
          hookTimeout: 10_000,
          pool: 'forks',
          // parallel (vitest default) — no singleFork
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'stateful',
          environment: 'node',
          include: ['src/server/**/*.test.ts'],
          exclude: ['src/server/**/*.unit.test.ts', '**/node_modules/**'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['src/test/setup-dom.ts'],
          testTimeout: 10_000,
          hookTimeout: 10_000,
          pool: 'forks',
        },
      },
    ],
  },
});
