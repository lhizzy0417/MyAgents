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

    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('MiniMax-M2.5');
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('MiniMax-M2.5');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('MiniMax-M2.5');
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
