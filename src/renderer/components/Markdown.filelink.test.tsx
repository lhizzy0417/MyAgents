import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openImagePreview: vi.fn(),
  readPreview: vi.fn(),
  readFileAsBlobUrl: vi.fn(),
  openWithDefault: vi.fn(),
  onOpenMyAgentsPreview: vi.fn(),
}));

vi.mock('@/utils/openExternal', async () => {
  const actual = await vi.importActual<typeof import('@/utils/openExternal')>('@/utils/openExternal');
  return {
    ...actual,
    openExternal: mocks.openExternal,
  };
});

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: mocks.openImagePreview }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    readPreview: mocks.readPreview,
    readFileAsBlobUrl: mocks.readFileAsBlobUrl,
    checkPaths: vi.fn(),
    openWithDefault: mocks.openWithDefault,
    openInFinder: vi.fn(),
  }),
}));

import { FileActionProvider } from '@/context/FileActionContext';

import Markdown from './Markdown';

const WORKSPACE = '/Users/zhihu/Documents/project/MyAgents';

function renderMarkdown(markdown: string, onFilePreviewExternal = vi.fn()) {
  render(
    <FileActionProvider
      workspacePath={WORKSPACE}
      onFilePreviewExternal={onFilePreviewExternal}
    >
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
  );
  return { onFilePreviewExternal };
}

function renderFloatingMarkdown(markdown: string) {
  render(
    <FileActionProvider
      workspacePath={WORKSPACE}
      menuProfile="floatingBall"
      onOpenMyAgentsPreview={mocks.onOpenMyAgentsPreview}
    >
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
  );
}

describe('Markdown local file links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.openWithDefault.mockResolvedValue(undefined);
    mocks.readPreview.mockResolvedValue({
      name: 'Message.tsx',
      content: 'export default function Message() {}',
      size: 36,
    });
  });

  it('opens workspace absolute path links in the MyAgents file preview instead of the system default app', async () => {
    const { onFilePreviewExternal } = renderMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx)`,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    await waitFor(() => {
      expect(onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Message.tsx',
        path: 'src/renderer/components/Message.tsx',
        content: 'export default function Message() {}',
      }));
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('preserves line suffixes from clickable file links', async () => {
    const { onFilePreviewExternal } = renderMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx:42)`,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    await waitFor(() => {
      expect(onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
        path: 'src/renderer/components/Message.tsx',
        initialLineNumber: 42,
      }));
    });
  });

  it('falls back to openExternal for absolute links outside the active workspace', () => {
    renderMarkdown('[Other.ts](/Users/zhihu/Other/Other.ts)');

    fireEvent.click(screen.getByRole('link', { name: 'Other.ts' }));

    expect(mocks.openExternal).toHaveBeenCalledWith('/Users/zhihu/Other/Other.ts');
    expect(mocks.readPreview).not.toHaveBeenCalled();
  });

  it('opens non-previewable workspace links with the default app instead of swallowing the click', async () => {
    renderMarkdown(`[Archive](${WORKSPACE}/dist/archive.zip)`);

    fireEvent.click(screen.getByRole('link', { name: 'Archive' }));

    await waitFor(() => {
      expect(mocks.openWithDefault).toHaveBeenCalledWith({ path: 'dist/archive.zip' });
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('opens previewable workspace links through the floating-ball MyAgents preview bridge', () => {
    renderFloatingMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx:42)`,
    );

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    expect(mocks.onOpenMyAgentsPreview).toHaveBeenCalledWith(
      'src/renderer/components/Message.tsx',
      {
        displayPath: `${WORKSPACE}/src/renderer/components/Message.tsx:42`,
        initialLineNumber: 42,
      },
    );
    expect(mocks.readPreview).not.toHaveBeenCalled();
    expect(mocks.openWithDefault).not.toHaveBeenCalled();
  });
});
