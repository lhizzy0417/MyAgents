import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { cancellableFetch } from './cancellation';
import { getHomeDirOrNull } from './platform';
import { getBundledCusePath } from './runtime';

const CUSE_VERSION_TIMEOUT_MS = 5_000;
const CUSE_LATEST_TIMEOUT_MS = 5_000;
const CUSE_LATEST_URL = 'https://download.myagents.io/cuse/latest.json';
const MAX_SKILL_CACHE_HASH_BYTES = 50 * 1024 * 1024;

const execFileAsync = promisify(execFile);

export interface CuseBinaryDiagnostic {
  path: string | null;
  exists: boolean;
  version: string | null;
  rawVersion: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  error?: string;
}

export interface CuseSkillCacheDiagnostic extends CuseBinaryDiagnostic {
  source: 'workspace' | 'myagents-user' | 'codex-user' | 'claude-user';
  label: string;
  differsFromBundledHash: boolean | null;
  notExecuted: true;
  checkCommand: string | null;
}

export interface CuseVersionMarkerDiagnostic {
  path: string;
  version: string | null;
  rawVersion: string;
  matchesBundled: boolean | null;
}

export interface CuseLatestDiagnostic {
  url: string;
  version: string | null;
  error?: string;
}

export interface CuseDiagnostics {
  presetCommand: '__bundled_cuse__';
  bundled: CuseBinaryDiagnostic;
  versionMarker: CuseVersionMarkerDiagnostic | null;
  r2Latest: CuseLatestDiagnostic | null;
  skillCaches: CuseSkillCacheDiagnostic[];
  warnings: string[];
}

type ExecRunner = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }>;

export interface GetCuseDiagnosticsOptions {
  workspacePath?: string;
  includeR2Latest?: boolean;
  homeDir?: string | null;
  resolveBundledCusePath?: () => string | null;
  execRunner?: ExecRunner;
  fetchLatest?: () => Promise<CuseLatestDiagnostic>;
}

export function normalizeCuseVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.trim().match(/\bv?(\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?)\b/);
  return match ? `v${match[1]}` : null;
}

function toText(value: string | Buffer | undefined): string {
  if (!value) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : value;
}

async function defaultExecRunner(
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number },
): Promise<{ stdout?: string | Buffer; stderr?: string | Buffer }> {
  return await execFileAsync(file, [...args], options);
}

async function inspectBinary(path: string | null, execRunner: ExecRunner): Promise<CuseBinaryDiagnostic> {
  if (!path) {
    return { path: null, exists: false, version: null, rawVersion: null, sha256: null, sizeBytes: null, error: 'not resolved' };
  }
  if (!existsSync(path)) {
    return { path, exists: false, version: null, rawVersion: null, sha256: null, sizeBytes: null, error: 'not found' };
  }
  const fingerprint = fingerprintFile(path, []);
  try {
    const result = await execRunner(path, ['--version'], {
      timeout: CUSE_VERSION_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    const raw = `${toText(result.stdout)}${toText(result.stderr)}`.trim();
    return {
      path,
      exists: true,
      version: normalizeCuseVersion(raw),
      rawVersion: raw || null,
      sha256: fingerprint.sha256,
      sizeBytes: fingerprint.sizeBytes,
      error: fingerprint.error,
    };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const raw = `${toText(e.stdout)}${toText(e.stderr)}`.trim();
    return {
      path,
      exists: true,
      version: normalizeCuseVersion(raw),
      rawVersion: raw || null,
      sha256: fingerprint.sha256,
      sizeBytes: fingerprint.sizeBytes,
      error: e.message ?? fingerprint.error ?? String(err),
    };
  }
}

function pathInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function existingRealRoots(paths: Array<string | null | undefined>): string[] {
  const roots: string[] = [];
  for (const path of paths) {
    if (!path || !existsSync(path)) continue;
    try {
      roots.push(realpathSync(path));
    } catch {
      /* ignore unreadable optional roots */
    }
  }
  return roots;
}

function fingerprintFile(path: string, safeRoots: string[]): { sha256: string | null; sizeBytes: number | null; error?: string } {
  try {
    const leaf = lstatSync(path);
    if (leaf.isSymbolicLink()) {
      return { sha256: null, sizeBytes: null, error: 'symlink leaf not fingerprinted' };
    }
    const realPath = realpathSync(path);
    if (safeRoots.length > 0 && !safeRoots.some(root => pathInside(realPath, root))) {
      return { sha256: null, sizeBytes: null, error: `real path outside trusted skill roots: ${realPath}` };
    }
    const stat = statSync(realPath);
    if (!stat.isFile()) {
      return { sha256: null, sizeBytes: stat.size, error: 'not a regular file' };
    }
    if (stat.size > MAX_SKILL_CACHE_HASH_BYTES) {
      return { sha256: null, sizeBytes: stat.size, error: `too large to fingerprint (${stat.size} bytes)` };
    }
    const sha256 = createHash('sha256').update(readFileSync(realPath)).digest('hex');
    return { sha256, sizeBytes: stat.size };
  } catch (err) {
    return {
      sha256: null,
      sizeBytes: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readVersionMarker(cusePath: string | null, bundledVersion: string | null): CuseVersionMarkerDiagnostic | null {
  if (!cusePath) return null;
  const markerPath = join(dirname(cusePath), '.cuse-version');
  if (!existsSync(markerPath)) return null;
  const rawVersion = readFileSync(markerPath, 'utf8').trim();
  const version = normalizeCuseVersion(rawVersion);
  return {
    path: markerPath,
    version,
    rawVersion,
    matchesBundled: version && bundledVersion ? version === bundledVersion : null,
  };
}

function uniqueSkillCacheCandidates(workspacePath: string | undefined, homeDir: string | null): Array<{
  source: CuseSkillCacheDiagnostic['source'];
  label: string;
  path: string;
}> {
  const binaryName = process.platform === 'win32' ? 'cuse.exe' : 'cuse';
  const candidates: Array<{
    source: CuseSkillCacheDiagnostic['source'];
    label: string;
    path: string;
  }> = [];
  if (workspacePath) {
    candidates.push({
      source: 'workspace',
      label: 'workspace .claude skill',
      path: join(workspacePath, '.claude', 'skills', 'cuse', 'scripts', binaryName),
    });
  }
  if (homeDir) {
    candidates.push(
      {
        source: 'myagents-user',
        label: '~/.myagents skill',
        path: join(homeDir, '.myagents', 'skills', 'cuse', 'scripts', binaryName),
      },
      {
        source: 'codex-user',
        label: '~/.codex skill',
        path: join(homeDir, '.codex', 'skills', 'cuse', 'scripts', binaryName),
      },
      {
        source: 'claude-user',
        label: '~/.claude skill',
        path: join(homeDir, '.claude', 'skills', 'cuse', 'scripts', binaryName),
      },
    );
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

async function inspectSkillCaches(
  workspacePath: string | undefined,
  homeDir: string | null,
  bundled: CuseBinaryDiagnostic,
): Promise<CuseSkillCacheDiagnostic[]> {
  const safeRoots = existingRealRoots([
    workspacePath,
    homeDir ? join(homeDir, '.myagents', 'skills', 'cuse') : null,
    homeDir ? join(homeDir, '.codex', 'skills', 'cuse') : null,
    homeDir ? join(homeDir, '.claude', 'skills', 'cuse') : null,
  ]);
  const existing = uniqueSkillCacheCandidates(workspacePath, homeDir)
    .filter(candidate => existsSync(candidate.path));
  return existing.map((candidate) => {
    const fingerprint = fingerprintFile(candidate.path, safeRoots);
    return {
      path: candidate.path,
      exists: true,
      version: null,
      rawVersion: null,
      sha256: fingerprint.sha256,
      sizeBytes: fingerprint.sizeBytes,
      error: fingerprint.error,
      source: candidate.source,
      label: candidate.label,
      differsFromBundledHash: fingerprint.sha256 && bundled.sha256
        ? fingerprint.sha256 !== bundled.sha256
        : null,
      notExecuted: true,
      checkCommand: process.platform === 'win32'
        ? `powershell -ExecutionPolicy Bypass -File "${join(dirname(candidate.path), 'install.ps1')}" -Check`
        : `bash "${join(dirname(candidate.path), 'install.sh')}" --check`,
    };
  });
}

async function defaultFetchLatest(): Promise<CuseLatestDiagnostic> {
  try {
    const resp = await cancellableFetch(CUSE_LATEST_URL, {
      headers: { 'Cache-Control': 'no-cache' },
    }, { timeoutMs: CUSE_LATEST_TIMEOUT_MS });
    if (!resp.ok) {
      return { url: CUSE_LATEST_URL, version: null, error: `HTTP ${resp.status}` };
    }
    const json = await resp.json() as { version?: unknown };
    return {
      url: CUSE_LATEST_URL,
      version: typeof json.version === 'string' ? normalizeCuseVersion(json.version) : null,
      error: typeof json.version === 'string' ? undefined : 'missing version',
    };
  } catch (err) {
    return {
      url: CUSE_LATEST_URL,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getCuseDiagnostics(options: GetCuseDiagnosticsOptions = {}): Promise<CuseDiagnostics> {
  const execRunner = options.execRunner ?? defaultExecRunner;
  const bundledPath = (options.resolveBundledCusePath ?? getBundledCusePath)();
  const bundled = await inspectBinary(bundledPath, execRunner);
  const versionMarker = readVersionMarker(bundled.path, bundled.version);
  const compareVersion = bundled.version ?? versionMarker?.version ?? null;
  const homeDir = options.homeDir === undefined
    ? (getHomeDirOrNull() ?? homedir())
    : options.homeDir;

  const [skillCaches, r2Latest] = await Promise.all([
    Promise.resolve(inspectSkillCaches(options.workspacePath, homeDir, bundled)),
    options.includeR2Latest ? (options.fetchLatest ?? defaultFetchLatest)() : Promise.resolve(null),
  ]);

  const warnings: string[] = [];
  if (!bundled.path) {
    warnings.push(`Bundled cuse is not available on this platform (${process.platform}).`);
  } else if (!bundled.exists) {
    warnings.push(`Bundled cuse path does not exist: ${bundled.path}`);
  } else if (bundled.error) {
    warnings.push(`Bundled cuse version check failed: ${bundled.error}`);
  }

  if (versionMarker?.matchesBundled === false) {
    warnings.push(`Bundled cuse marker ${versionMarker.rawVersion} does not match executable ${bundled.rawVersion ?? bundled.version ?? 'unknown'}.`);
  }
  if (r2Latest?.version && compareVersion && r2Latest.version !== compareVersion) {
    warnings.push(`R2 latest is ${r2Latest.version}, but bundled cuse is ${compareVersion}.`);
  }
  for (const cache of skillCaches) {
    if (cache.differsFromBundledHash) {
      warnings.push(`${cache.label} cache differs from the bundled cuse fingerprint and was not executed for safety: ${cache.path}`);
    }
    if (cache.error) {
      warnings.push(`${cache.label} cache fingerprint check failed: ${cache.error}`);
    }
  }

  return {
    presetCommand: '__bundled_cuse__',
    bundled,
    versionMarker,
    r2Latest,
    skillCaches,
    warnings,
  };
}
