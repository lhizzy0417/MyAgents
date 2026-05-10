/**
 * sessionHandoverClient — frontend wrappers for session ↔ channel surface
 * commands (PRD 0.2.14).
 *
 * Two operations:
 *   1. migrateChannelToNewSession — when desktop user clicks "+新对话" on a
 *      channel-bound session, the channel binding follows the new session.
 *      Equivalent to the IM bot `/new` command, but initiated from desktop.
 *
 *   2. handoverSessionToChannel — when desktop user clicks the 📤 button on
 *      a pure desktop session, the chosen channel's binding is replaced to
 *      route to this session. The channel sends a system notification.
 */

import { isTauriEnvironment } from '@/utils/browserMock';

let cachedInvoke: typeof import('@tauri-apps/api/core').invoke | null = null;

async function getInvoke() {
    if (!cachedInvoke) {
        const { invoke } = await import('@tauri-apps/api/core');
        cachedInvoke = invoke;
    }
    return cachedInvoke;
}

export interface MigrateChannelArgs {
    oldSessionId: string;
    /** session_key from `peer_sessions`, format `agent:{agentId}:{platform}:{type}:{id}` */
    sessionKey: string;
}

/**
 * Atomically rotate the IM channel binding from `oldSessionId` to a freshly
 * generated session id. Returns the new session id (caller should reload UI
 * onto it). Server-side this calls `router.reset_session(session_key)` which
 * does the heavy lifting (`/api/im/session/new` on sidecar +
 * `cmd_upgrade_session_id`).
 */
export async function migrateChannelToNewSession(args: MigrateChannelArgs): Promise<string | null> {
    if (!isTauriEnvironment()) return null;
    const invoke = await getInvoke();
    const result = await invoke<{ newSessionId: string }>(
        'cmd_session_new_with_surface_migration',
        { oldSessionId: args.oldSessionId, sessionKey: args.sessionKey },
    );
    return result?.newSessionId ?? null;
}

export interface HandoverArgs {
    /** Session id currently in the desktop tab — this is the session that will become channel-bound */
    sessionId: string;
    agentId: string;
    channelId: string;
    /** Workspace path of the desktop session — must match the Agent's workspacePath */
    workspacePath: string;
}

export interface HandoverResult {
    ok: boolean;
    /** sessionKey assigned to the new binding (caller can use to display) */
    sessionKey: string;
    /** Whether the IM notification reached the channel */
    notified: boolean;
}

/**
 * Bind a desktop session to an IM channel. The channel's previous bound
 * session (if any) is replaced — old session is released from the
 * `Agent` Sidecar owner, target session gains the `Agent` owner.
 *
 * Channel adapter sends a notification message to the chat.
 */
export async function handoverSessionToChannel(args: HandoverArgs): Promise<HandoverResult> {
    if (!isTauriEnvironment()) {
        throw new Error('Handover is only available in Tauri environment');
    }
    const invoke = await getInvoke();
    return invoke<HandoverResult>('cmd_handover_session_to_channel', {
        sessionId: args.sessionId,
        agentId: args.agentId,
        channelId: args.channelId,
        workspacePath: args.workspacePath,
    });
}
