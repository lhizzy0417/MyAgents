export interface WorkspaceFileLinkTarget {
  path: string;
  initialLineNumber?: number;
}

const EXTENSIONLESS_FILE_NAMES = new Set([
  'makefile',
  'dockerfile',
  'license',
  'readme',
  'changelog',
  'agents',
]);

export function resolveWorkspaceFileLinkTarget(
  href: string,
  workspacePath: string | null | undefined,
): WorkspaceFileLinkTarget | null {
  const workspace = workspacePath?.trim();
  const raw = href?.trim();
  if (!workspace || !raw) return null;

  const { base, line: hashLine } = stripHashLine(raw);
  const decodedBase = decodeUriLoose(base);
  const localPath = fileUrlToPath(decodedBase) ?? decodedBase;
  if (hasUnsupportedScheme(localPath)) return null;

  const { path: pathWithoutLine, line: suffixLine } = stripLineSuffix(localPath);
  const initialLineNumber = suffixLine ?? hashLine;
  const relativePath = toWorkspaceRelativePath(pathWithoutLine, workspace);
  if (!relativePath) return null;

  return initialLineNumber
    ? { path: relativePath, initialLineNumber }
    : { path: relativePath };
}

function stripHashLine(raw: string): { base: string; line?: number } {
  const hashIndex = raw.indexOf('#');
  if (hashIndex < 0) return { base: raw };

  const base = raw.slice(0, hashIndex);
  const hash = raw.slice(hashIndex + 1);
  const match = /^L(\d+)(?:-L?\d+)?$/i.exec(hash);
  const line = match ? positiveLine(match[1]) : undefined;
  return line ? { base, line } : { base: raw };
}

function stripLineSuffix(rawPath: string): { path: string; line?: number } {
  const match = /^(.*):(\d+)(?::\d+)?$/.exec(rawPath);
  if (!match) return { path: rawPath };

  const base = match[1];
  if (!base || /^[A-Za-z]$/.test(base)) return { path: rawPath };

  const line = positiveLine(match[2]);
  return line ? { path: base, line } : { path: rawPath };
}

function positiveLine(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function fileUrlToPath(raw: string): string | null {
  if (!/^file:\/\//i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.host && url.host !== 'localhost') return null;
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:[/\\]/.test(pathname)) {
      pathname = pathname.slice(1).replace(/\//g, '\\');
    }
    return pathname || null;
  } catch {
    return null;
  }
}

function hasUnsupportedScheme(raw: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return false;
  return /^[a-z][a-z0-9+\-.]*:/i.test(raw);
}

function toWorkspaceRelativePath(rawPath: string, workspacePath: string): string | null {
  const path = rawPath.trim();
  if (!path) return null;

  if (isAbsolutePath(path)) {
    return absoluteToWorkspaceRelative(path, workspacePath);
  }

  if (!looksLikeRelativeFileReference(path)) return null;
  return normalizeRelativePath(path);
}

function absoluteToWorkspaceRelative(rawPath: string, rawWorkspace: string): string | null {
  const path = stripTrailingSlash(normalizeSlashes(rawPath));
  const workspace = stripTrailingSlash(normalizeSlashes(rawWorkspace));
  const comparablePath = normalizeForCompare(path);
  const comparableWorkspace = normalizeForCompare(workspace);

  if (comparablePath === comparableWorkspace) return null;
  if (!comparablePath.startsWith(`${comparableWorkspace}/`)) return null;

  return normalizeRelativePath(path.slice(workspace.length + 1));
}

function normalizeRelativePath(rawPath: string): string | null {
  if (isAbsolutePath(rawPath)) return null;

  const parts = normalizeSlashes(rawPath).split('/');
  const stack: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  return stack.length > 0 ? stack.join('/') : null;
}

function looksLikeRelativeFileReference(rawPath: string): boolean {
  const path = normalizeSlashes(rawPath.trim());
  if (!path || path.startsWith('#')) return false;
  if (path.startsWith('./') || path.startsWith('../')) return true;
  if (path.includes('/')) return true;

  const name = path.toLowerCase();
  if (name.startsWith('.')) return true;
  if (EXTENSIONLESS_FILE_NAMES.has(name)) return true;
  return /\.[^./\\]+$/.test(path);
}

function isAbsolutePath(rawPath: string): boolean {
  return rawPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(rawPath);
}

function normalizeSlashes(rawPath: string): string {
  return decodeUriLoose(rawPath).replace(/\\/g, '/');
}

function normalizeForCompare(rawPath: string): string {
  const normalized = normalizeSlashes(rawPath);
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function stripTrailingSlash(rawPath: string): string {
  const normalized = normalizeSlashes(rawPath);
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, '');
}

function decodeUriLoose(raw: string): string {
  try {
    return decodeURI(raw);
  } catch {
    return raw;
  }
}
