import { describe, expect, it } from 'vitest';

import { resolveActionPath, resolveWorkspaceFileLinkTarget, resolveAgainstWorkspace } from './workspaceFileLinks';

const WORKSPACE = '/Users/zhihu/Documents/project/MyAgents';

describe('resolveWorkspaceFileLinkTarget', () => {
  it('turns workspace absolute links into workspace-relative paths', () => {
    expect(resolveWorkspaceFileLinkTarget(
      `${WORKSPACE}/src/renderer/components/Message.tsx`,
      WORKSPACE,
    )).toEqual({
      path: 'src/renderer/components/Message.tsx',
    });
  });

  it('extracts line suffixes from absolute path links', () => {
    expect(resolveWorkspaceFileLinkTarget(
      `${WORKSPACE}/src/renderer/components/Message.tsx:42`,
      WORKSPACE,
    )).toEqual({
      path: 'src/renderer/components/Message.tsx',
      initialLineNumber: 42,
    });
  });

  it('extracts #L line anchors', () => {
    expect(resolveWorkspaceFileLinkTarget(
      `${WORKSPACE}/src/renderer/components/Message.tsx#L12-L18`,
      WORKSPACE,
    )).toEqual({
      path: 'src/renderer/components/Message.tsx',
      initialLineNumber: 12,
    });
  });

  it('supports file URLs and percent-encoded spaces', () => {
    expect(resolveWorkspaceFileLinkTarget(
      'file:///Users/zhihu/Documents/project/MyAgents/docs/My%20Note.md:7',
      WORKSPACE,
    )).toEqual({
      path: 'docs/My Note.md',
      initialLineNumber: 7,
    });
  });

  it('passes plausible workspace-relative links through', () => {
    expect(resolveWorkspaceFileLinkTarget('./src/renderer/App.tsx', WORKSPACE)).toEqual({
      path: 'src/renderer/App.tsx',
    });
    expect(resolveWorkspaceFileLinkTarget('package.json', WORKSPACE)).toEqual({
      path: 'package.json',
    });
  });

  it('rejects links outside the workspace and non-file schemes', () => {
    expect(resolveWorkspaceFileLinkTarget('/Users/zhihu/Other/file.ts', WORKSPACE)).toBeNull();
    expect(resolveWorkspaceFileLinkTarget('https://example.com/file.ts', WORKSPACE)).toBeNull();
    expect(resolveWorkspaceFileLinkTarget('mailto:a@example.com', WORKSPACE)).toBeNull();
  });

  it('rejects relative traversal that escapes workspace root', () => {
    expect(resolveWorkspaceFileLinkTarget('../outside.ts', WORKSPACE)).toBeNull();
  });
});

describe('resolveAgainstWorkspace', () => {
  it('joins a workspace-relative path to an absolute path', () => {
    expect(resolveAgainstWorkspace('myagents_files/generated_audio/tts_x.mp3', WORKSPACE))
      .toBe('/Users/zhihu/Documents/project/MyAgents/myagents_files/generated_audio/tts_x.mp3');
  });

  it('normalizes ./ and collapses redundant segments', () => {
    expect(resolveAgainstWorkspace('./a/b.mp3', WORKSPACE)).toBe(`${WORKSPACE}/a/b.mp3`);
    expect(resolveAgainstWorkspace('a/./b/../c.mp3', WORKSPACE)).toBe(`${WORKSPACE}/a/c.mp3`);
  });

  it('passes an already-absolute path through unchanged (posix)', () => {
    expect(resolveAgainstWorkspace('/Users/me/.myagents/generated/x.mp3', WORKSPACE))
      .toBe('/Users/me/.myagents/generated/x.mp3');
  });

  it('passes an already-absolute Windows path through unchanged', () => {
    expect(resolveAgainstWorkspace('C:\\Users\\me\\x.mp3', 'C:\\ws')).toBe('C:\\Users\\me\\x.mp3');
  });

  it('joins under a Windows workspace (forward-slashed; PathBuf normalizes)', () => {
    expect(resolveAgainstWorkspace('audio/x.mp3', 'C:\\Users\\me\\ws'))
      .toBe('C:/Users/me/ws/audio/x.mp3');
  });

  it('returns null for a relative path with no workspace', () => {
    expect(resolveAgainstWorkspace('audio/x.mp3', null)).toBeNull();
    expect(resolveAgainstWorkspace('audio/x.mp3', '')).toBeNull();
  });

  it('returns null when the relative path escapes the workspace root', () => {
    expect(resolveAgainstWorkspace('../../etc/passwd', WORKSPACE)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(resolveAgainstWorkspace('', WORKSPACE)).toBeNull();
  });
});

describe('resolveActionPath', () => {
  it('normalizes an in-workspace absolute path to workspace-relative', () => {
    expect(resolveActionPath(`${WORKSPACE}/CLAUDE.md`, WORKSPACE)).toBe('CLAUDE.md');
    expect(resolveActionPath(`${WORKSPACE}/.claude/rules/04-MEMORY.md`, WORKSPACE))
      .toBe('.claude/rules/04-MEMORY.md');
  });

  it('passes a workspace-relative path through (normalized)', () => {
    expect(resolveActionPath('memory/2026-02-06.md', WORKSPACE)).toBe('memory/2026-02-06.md');
    expect(resolveActionPath('./src/App.tsx', WORKSPACE)).toBe('src/App.tsx');
  });

  it('leaves an absolute path OUTSIDE the workspace unchanged (backend will reject)', () => {
    expect(resolveActionPath('/etc/passwd', WORKSPACE)).toBe('/etc/passwd');
    expect(resolveActionPath('/Users/zhihu/Other/file.ts', WORKSPACE)).toBe('/Users/zhihu/Other/file.ts');
  });

  it('passes the raw path through when no workspace is known', () => {
    expect(resolveActionPath('memory/2026-02-06.md', null)).toBe('memory/2026-02-06.md');
    expect(resolveActionPath(`${WORKSPACE}/CLAUDE.md`, undefined)).toBe(`${WORKSPACE}/CLAUDE.md`);
  });

  it('passes a non-file-reference token through unchanged', () => {
    // toWorkspaceRelativePath can\'t classify it → fall back to the raw input.
    expect(resolveActionPath('foo', WORKSPACE)).toBe('foo');
  });
});
