// IM-source detection — shared with the renderer's `taskCenterUtils.isImSource`.
//
// The server cannot import renderer code (process boundary), and we don't want
// this single one-line check to grow a `shared/` dependency, so it lives here.
// Keep the suffix conventions in lock-step with renderer / SessionMetadata type
// (`SessionSource = 'desktop' | `${string}_private` | `${string}_group`).

import type { SessionSource } from '../types/session';

export function isImSourcedSession(source: SessionSource | string | undefined | null): boolean {
  if (!source) return false;
  if (source === 'desktop') return false;
  return source.endsWith('_private') || source.endsWith('_group');
}

/**
 * #305 — PATCH /sessions/:id snapshot-write guard.
 *
 * Returns `true` ONLY for "pure IM" sessions that must remain live-follow:
 * IM-shaped source AND no `configSnapshotAt` (so the snapshot has never been
 * captured). Returns `false` for desktop-to-IM handover sessions (IM source +
 * `configSnapshotAt` set, PRD 0.2.14) — those keep being snapshot-writeable
 * because the IM bridge reads "snapshot wins on delivery" for them.
 *
 * Mirrors the renderer's `shouldSkipSnapshotWrite` so server / client agree.
 */
export function shouldDropSnapshotPatchOnImSession(
  existingMeta: { source?: SessionSource | string | null; configSnapshotAt?: string | null } | null | undefined,
): boolean {
  if (!existingMeta) return false;
  if (existingMeta.configSnapshotAt) return false;
  return isImSourcedSession(existingMeta.source);
}
