import { describe, expect, it } from 'vitest';

import { resolveBuiltinPermissionMode, resolveLauncherProvider, shouldDegradedLoad } from './optionResolve';

describe('resolveBuiltinPermissionMode (#244)', () => {
  it('falls back to the agent config before the project sync runs (the bug)', () => {
    // Fresh tab: state still holds the mount-time 'auto' default, config has
    // just loaded with fullAgency. Must NOT ship 'auto'.
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: 'fullAgency',
        projectPermissionMode: 'plan',
        defaultPermissionMode: 'auto',
      }),
    ).toBe('fullAgency');
  });

  it('prefers project, then global default, when agent has none', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        agentPermissionMode: undefined,
        projectPermissionMode: 'plan',
      }),
    ).toBe('plan');
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: false,
        statePermissionMode: 'auto',
        defaultPermissionMode: 'fullAgency',
      }),
    ).toBe('fullAgency');
  });

  it('trusts state once synced (covers user toggle + session snapshot)', () => {
    expect(
      resolveBuiltinPermissionMode({
        projectSynced: true,
        statePermissionMode: 'plan',
        agentPermissionMode: 'fullAgency',
      }),
    ).toBe('plan');
  });

  it('falls back to state when nothing is configured', () => {
    expect(
      resolveBuiltinPermissionMode({ projectSynced: false, statePermissionMode: 'auto' }),
    ).toBe('auto');
  });
});

describe('resolveLauncherProvider (#234)', () => {
  it('uses the agent default when it diverges from the stale cache (the bug)', () => {
    // User changed Agent default MiniMax → DeepSeek; launcherLastUsed still
    // remembers MiniMax. Agent default must win, and the stale MiniMax model
    // must be dropped.
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    expect(r.model).toBe('deepseek-v4-flash');
  });

  it('keeps the cached provider+model when consistent with the agent', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'deepseek',
      lastUsedModel: 'deepseek-v4-pro',
      agentProviderId: 'deepseek',
      agentModel: 'deepseek-v4-flash',
    });
    expect(r.providerId).toBe('deepseek');
    // user's explicit launcher model choice survives within the same provider
    expect(r.model).toBe('deepseek-v4-pro');
  });

  it('honors the cache when the agent has no explicit provider', () => {
    const r = resolveLauncherProvider({
      lastUsedProviderId: 'minimax',
      lastUsedModel: 'MiniMax-M2.7',
      agentProviderId: undefined,
      workspaceProviderId: 'deepseek',
    });
    expect(r.providerId).toBe('minimax');
    expect(r.model).toBe('MiniMax-M2.7');
  });

  it('falls back agent → workspace → cache → global when no cache match', () => {
    expect(
      resolveLauncherProvider({ agentProviderId: 'openai' }).providerId,
    ).toBe('openai');
    expect(
      resolveLauncherProvider({ workspaceProviderId: 'deepseek' }).providerId,
    ).toBe('deepseek');
    expect(
      resolveLauncherProvider({ defaultProviderId: 'anthropic' }).providerId,
    ).toBe('anthropic');
  });
});

describe('shouldDegradedLoad (#235)', () => {
  const base = {
    mounted: true,
    currentSessionId: 's1',
    target: 's1',
    connectedSseSessionId: null as string | null,
    alreadyLoaded: false,
    prevSessionId: 's0' as string | null | undefined,
    sessionActiveOrStreaming: false,
  };

  it('fires when SSE never attached and the session is unchanged (the bug)', () => {
    expect(shouldDegradedLoad(base)).toBe(true);
  });

  it('does not fire while the session is mid-turn (active/streaming)', () => {
    expect(shouldDegradedLoad({ ...base, sessionActiveOrStreaming: true })).toBe(false);
  });

  it('does not fire after unmount', () => {
    expect(shouldDegradedLoad({ ...base, mounted: false })).toBe(false);
  });

  it('does not fire if the user switched sessions while waiting', () => {
    expect(shouldDegradedLoad({ ...base, currentSessionId: 's2' })).toBe(false);
  });

  it('does not fire if SSE attached after all', () => {
    expect(shouldDegradedLoad({ ...base, connectedSseSessionId: 's1' })).toBe(false);
  });

  it('does not fire if the session was already loaded', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's1' })).toBe(false);
  });

  it('still fires if alreadyLoaded but for a different prior session', () => {
    expect(shouldDegradedLoad({ ...base, alreadyLoaded: true, prevSessionId: 's0' })).toBe(true);
  });
});
