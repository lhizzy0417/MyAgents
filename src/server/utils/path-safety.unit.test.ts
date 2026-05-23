import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateExternalReadPathNode } from './path-safety';

const isWin = process.platform === 'win32';

describe('validateExternalReadPathNode — input validation', () => {
  it('rejects empty and relative paths', () => {
    expect(validateExternalReadPathNode('').ok).toBe(false);
    expect(validateExternalReadPathNode('relative/path.txt').ok).toBe(false);
    expect(validateExternalReadPathNode('./x.txt').ok).toBe(false);
  });
});

describe('validateExternalReadPathNode — blacklist (lexical, no fs)', () => {
  // canonicalizeSymlinks:false → pure lexical check, deterministic + no disk.
  const lexical = (p: string) => validateExternalReadPathNode(p, { canonicalizeSymlinks: false });

  it.skipIf(isWin)('rejects POSIX system directories', () => {
    expect(lexical('/etc/passwd').ok).toBe(false);
    expect(lexical('/usr/bin/node').ok).toBe(false);
    expect(lexical('/root/.bashrc').ok).toBe(false);
    // Folds .. before checking — can't escape via traversal.
    expect(lexical('/home/user/../../etc/shadow').ok).toBe(false);
  });

  it('rejects credential directories under HOME (.ssh, .aws, …)', () => {
    const home = homedir();
    expect(lexical(path.join(home, '.ssh', 'id_rsa')).ok).toBe(false);
    expect(lexical(path.join(home, '.aws', 'credentials')).ok).toBe(false);
    expect(lexical(path.join(home, '.config', 'op', 'config')).ok).toBe(false);
  });

  it('allows an ordinary file under HOME/Documents', () => {
    const ok = lexical(path.join(homedir(), 'Documents', 'notes.txt'));
    expect(ok.ok).toBe(true);
  });
});

// Symlink-escape defense needs real inodes; POSIX only (Windows symlink needs
// elevation). The headline attack: ~/.codex/evil_link → /etc, read through it.
describe.skipIf(isWin)('validateExternalReadPathNode — symlink escape (real fs)', () => {
  // Sandbox under HOME, NOT os.tmpdir(): on macOS tmpdir is /var/folders/... and
  // /var is itself blacklisted, which would mask the symlink/realpath checks.
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(path.join(homedir(), '.ma-pathsafety-test-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('accepts a real regular file (canonicalize on)', () => {
    const f = path.join(dir, 'real.txt');
    writeFileSync(f, 'hi');
    expect(validateExternalReadPathNode(f).ok).toBe(true);
  });

  it('rejects a symlink leaf outright (defense-in-depth, before realpath)', () => {
    const link = path.join(dir, 'leaf_link');
    symlinkSync('/etc', link);
    const res = validateExternalReadPathNode(link);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/symbolic link/i);
  });

  it('rejects a path whose parent symlink resolves into a blacklisted dir', () => {
    const evil = path.join(dir, 'evil_link');
    // Target /usr (a REAL dir on both macOS and Linux). NB: /etc and /var are
    // symlinks to /private/* on macOS, and the blacklist lists /etc|/var but not
    // /private/* — so an /etc target would slip the realpath recheck on macOS
    // (a known gap; for tool attachments the positive allow-list still catches
    // it). /usr exercises the realpath→blacklist recheck portably.
    symlinkSync('/usr', evil); // evil_link → /usr
    // realpath(evil_link/bin) === /usr/bin → blacklist catches /usr.
    const res = validateExternalReadPathNode(path.join(evil, 'bin'));
    expect(res.ok).toBe(false);
  });

  // Regression for the macOS /etc→/private/etc blacklist gap: realpath of a
  // symlink-escape into /etc lands in /private/etc, which the bare /etc entry
  // missed. The darwin blacklist now also lists /private/etc | /private/var.
  it.runIf(process.platform === 'darwin')('rejects realpath-escape into /private/etc (macOS /etc symlink)', () => {
    const evil = path.join(dir, 'etc_link');
    symlinkSync('/etc', evil); // /etc → /private/etc on macOS
    const res = validateExternalReadPathNode(path.join(evil, 'hosts'));
    expect(res.ok).toBe(false); // realpath → /private/etc/hosts → blacklisted
  });
});
