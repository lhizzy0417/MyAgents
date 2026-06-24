import type { SessionMetadata } from '../types/session';
import { getDefaultRuntimePermissionMode, type RuntimeType } from '../../shared/types/runtime';

type SessionSnapshotPatchKey =
  | 'model'
  | 'reasoningEffort'
  | 'permissionMode'
  | 'mcpEnabledServers'
  | 'enabledPluginIds'
  | 'providerId'
  | 'providerEnvJson';

export type SessionSnapshotPatchPayload = {
  [K in SessionSnapshotPatchKey]?: SessionMetadata[K] | null;
};

const SNAPSHOT_KEYS = [
  'model',
  'reasoningEffort',
  'permissionMode',
  'mcpEnabledServers',
  'enabledPluginIds',
  'providerId',
  'providerEnvJson',
] as const satisfies ReadonlyArray<keyof SessionSnapshotPatchPayload>;

const BASELINE_KEYS = [
  'runtime',
  ...SNAPSHOT_KEYS,
] as const satisfies ReadonlyArray<keyof SessionMetadata>;

type SnapshotUpdate = Partial<Pick<SessionMetadata, (typeof BASELINE_KEYS)[number] | 'configSnapshotAt'>>;

function copyPresentSnapshotFields(source: Partial<SessionMetadata> | undefined): SnapshotUpdate {
  const copied: SnapshotUpdate = {};
  if (!source) return copied;
  for (const key of BASELINE_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      (copied as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return copied;
}

/**
 * Build the metadata update for PATCH /sessions/:id config-snapshot fields.
 *
 * Important ownership rule: the first desktop config edit promotes a legacy
 * session into a self-owned session. That promotion must freeze a complete
 * baseline before applying the explicit patch; otherwise a model-only patch
 * creates `model + configSnapshotAt` and silently drops permission/provider.
 */
export function buildSessionSnapshotPatchUpdates(args: {
  existing: SessionMetadata;
  payload: SessionSnapshotPatchPayload;
  baseSnapshot?: Partial<SessionMetadata>;
  nowIso: string;
}): SnapshotUpdate {
  const explicit: SnapshotUpdate = {};
  let wroteSnapshotField = false;

  for (const key of SNAPSHOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(args.payload, key)) continue;
    const value = args.payload[key];
    (explicit as Record<string, unknown>)[key] = value === null ? undefined : value;
    wroteSnapshotField = true;
  }

  if (
    Object.prototype.hasOwnProperty.call(args.payload, 'providerId') &&
    !Object.prototype.hasOwnProperty.call(args.payload, 'providerEnvJson')
  ) {
    explicit.providerEnvJson = undefined;
    wroteSnapshotField = true;
  }

  if (!wroteSnapshotField) return {};

  if (args.existing.configSnapshotAt) {
    return {
      ...explicit,
      configSnapshotAt: args.nowIso,
    };
  }

  const baseline = {
    ...copyPresentSnapshotFields(args.baseSnapshot),
    ...copyPresentSnapshotFields(args.existing),
  };
  const runtime = (baseline.runtime ?? args.baseSnapshot?.runtime ?? args.existing.runtime ?? 'builtin') as RuntimeType;
  baseline.runtime ??= runtime;
  baseline.permissionMode ??= getDefaultRuntimePermissionMode(runtime);
  baseline.reasoningEffort ??= 'default';

  return {
    ...baseline,
    ...explicit,
    configSnapshotAt: args.nowIso,
  };
}
