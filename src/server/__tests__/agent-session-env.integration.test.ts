import { delimiter, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildClaudeSessionEnv } from '../agent-session';

describe('buildClaudeSessionEnv npm prefix isolation', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not leak MyAgents npm prefix variables into the SDK shell env', () => {
    const home = process.platform === 'win32'
      ? 'C:\\Users\\myagents-test'
      : '/tmp/myagents-env-home';
    const prefix = process.platform === 'win32'
      ? resolve(home, '.myagents', 'npm-global')
      : `${home}/.myagents/npm-global`;
    const binDir = process.platform === 'win32' ? prefix : `${prefix}/bin`;

    vi.stubEnv(process.platform === 'win32' ? 'USERPROFILE' : 'HOME', home);
    vi.stubEnv('npm_config_prefix', prefix);
    vi.stubEnv('NPM_CONFIG_PREFIX', prefix);
    vi.stubEnv('PREFIX', prefix);

    const env = buildClaudeSessionEnv();
    const pathValue = env[process.platform === 'win32' ? 'Path' : 'PATH'] ?? '';

    expect(env.npm_config_prefix).toBeUndefined();
    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(env.PREFIX).toBeUndefined();
    expect(env.MYAGENTS_NPM_GLOBAL_PREFIX).toBe(prefix);
    expect(pathValue.split(delimiter)).toContain(binDir);
  });
});

describe('session model alias resolution', () => {
  it('uses the active model for built-in subagent alias env when aliases are collapsed', () => {
    const env = buildClaudeSessionEnv(
      {
        baseUrl: 'https://api.minimax.example',
        apiKey: 'test-key',
        modelAliases: {
          sonnet: 'MiniMax-M2.7',
          opus: 'MiniMax-M2.7',
          haiku: 'MiniMax-M2.7',
        },
      },
      'MiniMax-M2.5',
    );

    // #335 — MiniMax-M2.5's preset contextLength is 204_800 (> the SDK 200K
    // default), so the SDK-ingress `_MODEL` envs carry the `[1m]` unlock; the
    // display-label `_MODEL_NAME` env stays raw (applyContextWindowSuffix
    // contract: wrapped values flow ONLY into SDK ingress points).
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.5[1m]');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.5[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME).toBe('MiniMax-M2.5');
  });

  it('keeps split subagent alias env unchanged', () => {
    const env = buildClaudeSessionEnv(
      {
        baseUrl: 'https://api.deepseek.example',
        apiKey: 'test-key',
        modelAliases: {
          sonnet: 'provider-pro',
          opus: 'provider-pro',
          haiku: 'provider-flash',
        },
      },
      'provider-pro',
    );

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('provider-pro');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('provider-pro');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('provider-flash');
  });
});

describe('Claude SDK context window env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps Claude 4.6 defaults at 200K without forcing SDK 1M disable flags (#392)', () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT', '');
    vi.stubEnv('CLAUDE_CODE_ENABLE_1M_CONTEXT', '1');

    const env = buildClaudeSessionEnv(undefined, 'claude-opus-4-6');

    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('');
    expect(env.CLAUDE_CODE_ENABLE_1M_CONTEXT).toBe('1');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
  });

  it('keeps Opus 4.7 / 4.8 on the default 1M window', () => {
    expect(buildClaudeSessionEnv(undefined, 'claude-opus-4-7').CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
    expect(buildClaudeSessionEnv(undefined, 'claude-opus-4-8').CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1000000');
  });

  it('keeps provider-routed sessions eligible for registry-backed SDK 1M unlocks', () => {
    const env = buildClaudeSessionEnv(
      {
        providerId: 'minimax',
        baseUrl: 'https://api.minimax.example',
        apiKey: 'test-key',
        modelAliases: {
          sonnet: 'MiniMax-M2.7',
          opus: 'MiniMax-M2.7',
          haiku: 'MiniMax-M2.7',
        },
      },
      'MiniMax-M2.5',
    );

    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBeUndefined();
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('204800');
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.5[1m]');
  });
});
