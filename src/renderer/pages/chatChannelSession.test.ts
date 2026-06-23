import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelSurface } from '@/hooks/useSessionSurfaces';
import { transitionChannelBoundSession } from './chatChannelSession';

const channel: ChannelSurface = {
  agentId: 'agent-1',
  agentName: 'Agent',
  channelId: 'channel-1',
  channelType: 'openclaw:feishu',
  channelName: 'Feishu',
  sessionKey: 'agent:agent-1:openclaw:feishu:private:user-1',
  sourceType: 'private',
  sourceId: 'user-1',
  sourceDisplayName: 'User',
  platformLabel: 'Feishu',
  status: 'online',
};

const mocks = {
  migrateChannelToNewSession: vi.fn(),
  adoptMigratedSession: vi.fn(),
  resetSession: vi.fn(),
  reportError: vi.fn(),
};

function runTransition(allowPlainResetFallback: boolean) {
  return transitionChannelBoundSession({
    sessionId: 'old-session',
    boundChannel: channel,
    migrateChannelToNewSession: mocks.migrateChannelToNewSession,
    adoptMigratedSession: mocks.adoptMigratedSession,
    resetSession: mocks.resetSession,
    reportError: mocks.reportError,
    allowPlainResetFallback,
  });
}

describe('transitionChannelBoundSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.adoptMigratedSession.mockResolvedValue(true);
    mocks.resetSession.mockResolvedValue(true);
  });

  it('adopts the migrated channel session without plain reset', async () => {
    mocks.migrateChannelToNewSession.mockResolvedValue('new-session');

    await expect(runTransition(false)).resolves.toBe(true);

    expect(mocks.migrateChannelToNewSession).toHaveBeenCalledWith({
      oldSessionId: 'old-session',
      sessionKey: channel.sessionKey,
    });
    expect(mocks.adoptMigratedSession).toHaveBeenCalledWith('new-session', { sidecarAlreadyMigrated: true });
    expect(mocks.resetSession).not.toHaveBeenCalled();
  });

  it('allows plain reset fallback for normal new-session clicks', async () => {
    mocks.migrateChannelToNewSession.mockResolvedValue(null);

    await expect(runTransition(true)).resolves.toBe(true);

    expect(mocks.resetSession).toHaveBeenCalledTimes(1);
  });

  it('fails closed for delete preparation when migration returns null', async () => {
    mocks.migrateChannelToNewSession.mockResolvedValue(null);

    await expect(runTransition(false)).resolves.toBe(false);

    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith('Channel 重绑失败，已取消删除');
  });

  it('fails closed for delete preparation when migration throws', async () => {
    mocks.migrateChannelToNewSession.mockRejectedValue(new Error('offline'));

    await expect(runTransition(false)).resolves.toBe(false);

    expect(mocks.resetSession).not.toHaveBeenCalled();
    expect(mocks.reportError).toHaveBeenCalledWith('Channel 重绑失败，已取消删除');
  });
});
