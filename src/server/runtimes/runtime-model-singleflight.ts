import type { RuntimeType } from '../../shared/types/runtime';
import { elapsedMs, emitPerfTrace, nowMs } from '../utils/perf-trace';

const inFlightModelQueries = new Map<RuntimeType, Promise<unknown[]>>();

export async function queryRuntimeModelsSingleFlight(
  runtimeType: RuntimeType,
  queryer: () => Promise<unknown[]>,
): Promise<unknown[]> {
  if (runtimeType === 'builtin') return [];

  const existing = inFlightModelQueries.get(runtimeType);
  if (existing) {
    emitPerfTrace({
      trace: 'runtime',
      phase: 'model_list_join',
      runtime: runtimeType,
      status: 'ok',
    });
    return existing;
  }

  const start = nowMs();
  emitPerfTrace({
    trace: 'runtime',
    phase: 'model_list_start',
    runtime: runtimeType,
  });

  const promise = (async () => {
    try {
      const models = await queryer();
      emitPerfTrace({
        trace: 'runtime',
        phase: 'model_list_done',
        runtime: runtimeType,
        durationMs: elapsedMs(start),
        count: models.length,
        status: 'ok',
      });
      return models;
    } catch (error) {
      emitPerfTrace({
        trace: 'runtime',
        phase: 'model_list_done',
        runtime: runtimeType,
        durationMs: elapsedMs(start),
        status: 'error',
      });
      throw error;
    } finally {
      inFlightModelQueries.delete(runtimeType);
    }
  })();

  inFlightModelQueries.set(runtimeType, promise);
  return promise;
}

export function __resetRuntimeModelSingleFlightForTest(): void {
  inFlightModelQueries.clear();
}
