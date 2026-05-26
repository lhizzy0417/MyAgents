import { describe, expect, it } from 'vitest';

import { resolveWorkspaceFileLinkTarget } from './workspaceFileLinks';

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
