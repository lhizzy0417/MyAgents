import { describe, expect, it } from 'vitest';
import { diagnoseSdkSubprocessFailure } from './sdk-subprocess-diagnostics';

describe('diagnoseSdkSubprocessFailure', () => {
  it('maps Windows exit code 1 to Git for Windows guidance', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code 1',
    });

    expect(diagnostic?.kind).toBe('windows-git-bash-missing');
    expect(diagnostic?.userMessage).toContain('Git for Windows');
  });

  it('maps unsigned STATUS_STACK_BUFFER_OVERRUN to SDK native Bun crash guidance', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code 3221226505',
    });

    expect(diagnostic?.kind).toBe('windows-native-bun-crash');
    expect(diagnostic?.exitCodeHex).toBe('0xC0000409');
    expect(diagnostic?.userMessage).toBe('Claude Agent SDK 启动失败（exit code 3221226505 / 0xC0000409），请检查运行环境。');
    expect(diagnostic?.imMessage).toBe(diagnostic?.userMessage);
  });

  it('maps signed Windows native crash exit codes', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process exited with code -1073740791',
    });

    expect(diagnostic?.exitCode).toBe(3221226505);
    expect(diagnostic?.exitCodeHex).toBe('0xC0000409');
  });

  it('uses Bun stderr as crash evidence when the exit message has no code', () => {
    const diagnostic = diagnoseSdkSubprocessFailure({
      platform: 'win32',
      errorMessage: 'Claude Code process terminated',
      stderr: [
        'panic(main thread): Illegal instruction at address 0x7FF6D5DAEF90',
        'oh no: Bun has crashed. This indicates a bug in Bun, not your code.',
      ],
    });

    expect(diagnostic?.kind).toBe('windows-native-bun-crash');
    expect(diagnostic?.exitCode).toBeUndefined();
  });

  it('does not classify non-Windows failures', () => {
    expect(diagnoseSdkSubprocessFailure({
      platform: 'darwin',
      errorMessage: 'Claude Code process exited with code 3221226505',
    })).toBeNull();
  });
});
