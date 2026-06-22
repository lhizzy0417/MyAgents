import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCuseDiagnostics, normalizeCuseVersion } from './cuse-diagnostics';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'myagents-cuse-diagnostics-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cuse diagnostics', () => {
  it('normalizes cuse version output', () => {
    expect(normalizeCuseVersion('cuse 0.2.2')).toBe('v0.2.2');
    expect(normalizeCuseVersion('v0.2.2')).toBe('v0.2.2');
    expect(normalizeCuseVersion('')).toBeNull();
  });

  it('fingerprints workspace skill-local cuse caches without executing project files', async () => {
    const root = makeTempDir();
    const binariesDir = join(root, 'src-tauri', 'binaries');
    const workspaceDir = join(root, 'workspace');
    const bundledPath = join(binariesDir, 'cuse-aarch64-apple-darwin');
    const skillPath = join(workspaceDir, '.claude', 'skills', 'cuse', 'scripts', 'cuse');
    mkdirSync(binariesDir, { recursive: true });
    mkdirSync(join(workspaceDir, '.claude', 'skills', 'cuse', 'scripts'), { recursive: true });
    writeFileSync(bundledPath, 'bundled-cuse');
    writeFileSync(join(binariesDir, '.cuse-version'), 'v0.2.2');
    writeFileSync(skillPath, 'stale-skill-cuse');

    const executed: string[] = [];

    const diagnostics = await getCuseDiagnostics({
      workspacePath: workspaceDir,
      homeDir: null,
      includeR2Latest: false,
      resolveBundledCusePath: () => bundledPath,
      execRunner: async (file) => {
        executed.push(file);
        return { stdout: 'cuse 0.2.2\n' };
      },
    });

    expect(diagnostics.bundled.version).toBe('v0.2.2');
    expect(executed).toEqual([bundledPath]);
    expect(diagnostics.versionMarker?.matchesBundled).toBe(true);
    expect(diagnostics.skillCaches).toHaveLength(1);
    expect(diagnostics.skillCaches[0].version).toBeNull();
    expect(diagnostics.skillCaches[0].differsFromBundledHash).toBe(true);
    expect(diagnostics.skillCaches[0].notExecuted).toBe(true);
    expect(diagnostics.warnings.join('\n')).toContain('workspace .claude skill cache differs from the bundled cuse fingerprint');
  });

  it('reports R2 latest divergence when requested', async () => {
    const root = makeTempDir();
    const bundledPath = join(root, 'cuse');
    writeFileSync(bundledPath, '');

    const diagnostics = await getCuseDiagnostics({
      homeDir: null,
      includeR2Latest: true,
      resolveBundledCusePath: () => bundledPath,
      execRunner: async () => ({ stdout: 'cuse 0.2.1\n' }),
      fetchLatest: async () => ({
        url: 'https://download.myagents.io/cuse/latest.json',
        version: 'v0.2.2',
      }),
    });

    expect(diagnostics.r2Latest?.version).toBe('v0.2.2');
    expect(diagnostics.warnings).toContain('R2 latest is v0.2.2, but bundled cuse is v0.2.1.');
  });
});
