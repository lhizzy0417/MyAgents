import type { ChannelSurface } from '@/hooks/useSessionSurfaces';

interface ChannelBoundSessionTransitionOptions {
  sessionId: string;
  boundChannel: ChannelSurface;
  migrateChannelToNewSession: (args: { oldSessionId: string; sessionKey: string }) => Promise<string | null>;
  adoptMigratedSession: (newSessionId: string, options: { sidecarAlreadyMigrated: true }) => Promise<boolean>;
  resetSession: () => Promise<boolean>;
  reportError: (message: string) => void;
  allowPlainResetFallback: boolean;
}

/**
 * Move a channel-bound desktop tab to a fresh session.
 *
 * Normal "新对话" can fall back to a plain reset when the channel migration
 * fails, because the user still gets a usable local conversation. Delete
 * preparation cannot: deleting the old session is only safe after the channel
 * binding and Agent owner have actually moved.
 */
export async function transitionChannelBoundSession(
  options: ChannelBoundSessionTransitionOptions,
): Promise<boolean> {
  const {
    sessionId,
    boundChannel,
    migrateChannelToNewSession,
    adoptMigratedSession,
    resetSession,
    reportError,
    allowPlainResetFallback,
  } = options;

  try {
    const newSessionId = await migrateChannelToNewSession({
      oldSessionId: sessionId,
      sessionKey: boundChannel.sessionKey,
    });

    if (newSessionId) {
      console.log(`[Chat] Channel-bound new conversation: ${sessionId.slice(0, 8)} -> ${newSessionId.slice(0, 8)}`);
      const adopted = await adoptMigratedSession(newSessionId, { sidecarAlreadyMigrated: true });
      if (!adopted) {
        throw new Error(`Failed to adopt migrated channel session ${newSessionId}.`);
      }
      return true;
    }

    console.warn('[Chat] migrateChannelToNewSession returned null');
    reportError(allowPlainResetFallback ? 'Channel 重绑失败，已就地重置' : 'Channel 重绑失败，已取消删除');
    if (!allowPlainResetFallback) return false;
    return await resetSession();
  } catch (err) {
    console.error('[Chat] Channel surface migration failed:', err);
    reportError(allowPlainResetFallback ? 'Channel 重绑失败，已就地重置' : 'Channel 重绑失败，已取消删除');
    if (!allowPlainResetFallback) return false;
    return await resetSession();
  }
}
