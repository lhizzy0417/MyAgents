/**
 * SessionSurfaceTags — top-bar badge cluster for the current Chat tab's
 * session. Pure visual indicator: shows which IM channel is bound and/or
 * whether a cron task currently owns this session.
 *
 * Layout (immediately after session title):
 *
 *   pure desktop, no cron                          → (nothing)
 *   channel-bound                                  → [●飞书]
 *   pure desktop + cron                            → [●定时]
 *   channel-bound + cron                           → [●飞书][●定时]
 *
 * Both pills are non-interactive; the menu button rendered next to this
 * cluster (SessionMenuButton) owns all session actions including the
 * channel handover flow that used to live on this row.
 */
import SessionTagBadge from './SessionTagBadge';
import type { ChannelSurface, CronSurface } from '@/hooks/useSessionSurfaces';

export interface SessionSurfaceTagsProps {
    channel: ChannelSurface | null;
    cron: CronSurface | null;
}

export default function SessionSurfaceTags({
    channel,
    cron,
}: SessionSurfaceTagsProps) {
    if (!channel && !cron) return null;

    return (
        <div className="flex shrink-0 items-center gap-1">
            {channel && (
                <SessionTagBadge tag={{ type: 'im', platform: channel.platformLabel }} />
            )}
            {cron && <SessionTagBadge tag={{ type: 'cron' }} />}
        </div>
    );
}
