import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetRuntimeModelSingleFlightForTest,
  queryRuntimeModelsSingleFlight,
} from './runtime-model-singleflight';

describe('runtime model query single-flight', () => {
  beforeEach(() => {
    __resetRuntimeModelSingleFlightForTest();
  });

  it('deduplicates concurrent queries for the same runtime', async () => {
    let release!: (value: unknown[]) => void;
    const queryer = vi.fn(() => new Promise<unknown[]>((resolve) => { release = resolve; }));

    const a = queryRuntimeModelsSingleFlight('codex', queryer);
    const b = queryRuntimeModelsSingleFlight('codex', queryer);

    release([{ value: 'gpt', displayName: 'GPT' }]);

    await expect(Promise.all([a, b])).resolves.toEqual([
      [{ value: 'gpt', displayName: 'GPT' }],
      [{ value: 'gpt', displayName: 'GPT' }],
    ]);
    expect(queryer).toHaveBeenCalledTimes(1);
  });

  it('clears in-flight state after rejection', async () => {
    const queryer = vi.fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([{ value: 'ok' }]);

    await expect(queryRuntimeModelsSingleFlight('gemini', queryer)).rejects.toThrow('boom');
    await expect(queryRuntimeModelsSingleFlight('gemini', queryer)).resolves.toEqual([{ value: 'ok' }]);
    expect(queryer).toHaveBeenCalledTimes(2);
  });

  it('does not single-flight builtin runtime', async () => {
    const queryer = vi.fn(async () => [{ value: 'should-not-run' }]);

    await expect(queryRuntimeModelsSingleFlight('builtin', queryer)).resolves.toEqual([]);
    expect(queryer).not.toHaveBeenCalled();
  });
});
