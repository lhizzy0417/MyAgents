import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();

describe('SessionEngine runtime boundary', () => {
  it('keeps Phase5 migrated route modules behind SessionEngine instead of direct builtin/external adapters', () => {
    const routeFiles = [
      'src/server/routes/session-read.ts',
      'src/server/routes/chat-stream.ts',
      'src/server/routes/session-config.ts',
      'src/server/routes/session-operations.ts',
    ].map(file => join(repoRoot, file));
    const forbidden = [
      '../agent-session',
      '../runtimes/external-session',
      'enqueueUserMessage(',
      'sendExternalMessage(',
      'waitForSessionIdle(',
      'waitForExternalSessionIdle(',
      'shouldUseExternalRuntime(',
      'didLastTurnSucceed(',
      'getAndClearLastAgentError(',
    ];

    const violations = routeFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbidden
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it('does not reintroduce route-level runtime selection in the monolithic server entrypoint', () => {
    const source = readFileSync(join(repoRoot, 'src/server/index.ts'), 'utf8');

    expect(source).not.toContain('shouldUseExternalRuntime(');
    expect(source).not.toContain('sendExternalMessage(');
    expect(source).not.toContain('enqueueUserMessage(');
    expect(source).not.toContain('waitForExternalSessionIdle(');
    expect(source).not.toContain('waitForSessionIdle(');
    expect(source).not.toContain('didLastTurnSucceed(');
    expect(source).not.toContain('getAndClearLastAgentError(');
  });
});
