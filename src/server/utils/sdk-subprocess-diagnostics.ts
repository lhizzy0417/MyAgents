export type SdkSubprocessFailureKind =
  | 'windows-git-bash-missing'
  | 'windows-native-bun-crash';

export interface SdkSubprocessFailureDiagnostic {
  kind: SdkSubprocessFailureKind;
  userMessage: string;
  imMessage: string;
  exitCode?: number;
  exitCodeHex?: string;
}

const UINT32_MAX_PLUS_ONE = 0x1_0000_0000;

const WINDOWS_NATIVE_CRASH_CODES = new Set([
  0xc000001d, // STATUS_ILLEGAL_INSTRUCTION
  0xc0000005, // STATUS_ACCESS_VIOLATION
  0xc0000409, // STATUS_STACK_BUFFER_OVERRUN
]);

function normalizeWindowsExitCode(code: number): number {
  return code < 0 ? code + UINT32_MAX_PLUS_ONE : code;
}

function formatHexCode(code: number): string {
  return `0x${normalizeWindowsExitCode(code).toString(16).toUpperCase().padStart(8, '0')}`;
}

function parseProcessExitCode(raw: string): number | undefined {
  const match = raw.match(/(?:process exited with code|exit code)\s+(-?\d+)/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? normalizeWindowsExitCode(parsed) : undefined;
}

function hasBunNativeCrashEvidence(raw: string): boolean {
  return /Bun has crashed|Illegal instruction|Failed to start HTTP Client thread|panic\([^)]*\):/i.test(raw);
}

export function diagnoseSdkSubprocessFailure(input: {
  errorMessage: string;
  stderr?: readonly string[];
  platform?: NodeJS.Platform | string;
}): SdkSubprocessFailureDiagnostic | null {
  const platform = input.platform ?? process.platform;
  if (platform !== 'win32') return null;

  const raw = [input.errorMessage, ...(input.stderr ?? [])].join('\n');
  const exitCode = parseProcessExitCode(raw);

  if (exitCode === 1) {
    return {
      kind: 'windows-git-bash-missing',
      exitCode,
      exitCodeHex: formatHexCode(exitCode),
      userMessage: '子进程启动失败 (exit code 1)。最可能原因：未安装 Git for Windows。请安装 Git：https://git-scm.com/downloads/win',
      imMessage: 'AI 引擎启动失败：Windows 机器可能未安装 Git for Windows。请在桌面端安装 Git 后重试。',
    };
  }

  const isNativeCrash = exitCode !== undefined && WINDOWS_NATIVE_CRASH_CODES.has(exitCode);
  if (!isNativeCrash && !hasBunNativeCrashEvidence(raw)) return null;

  const codeSuffix = exitCode === undefined
    ? ''
    : `（exit code ${exitCode} / ${formatHexCode(exitCode)}）`;

  return {
    kind: 'windows-native-bun-crash',
    exitCode,
    exitCodeHex: exitCode === undefined ? undefined : formatHexCode(exitCode),
    userMessage: `Claude Agent SDK 启动失败${codeSuffix}，请检查运行环境。`,
    imMessage: `Claude Agent SDK 启动失败${codeSuffix}，请检查运行环境。`,
  };
}
