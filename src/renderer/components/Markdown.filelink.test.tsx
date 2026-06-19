import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openImagePreview: vi.fn(),
  checkPaths: vi.fn(),
  checkLocalPaths: vi.fn(),
  readPreview: vi.fn(),
  readLocalPreview: vi.fn(),
  readFileAsBlobUrl: vi.fn(),
  openWithDefault: vi.fn(),
  openPathWithDefault: vi.fn(),
  openPathExternal: vi.fn(),
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
    readLocalPreview: mocks.readLocalPreview,
    readFileAsBlobUrl: mocks.readFileAsBlobUrl,
    checkPaths: mocks.checkPaths,
    checkLocalPaths: mocks.checkLocalPaths,
    openWithDefault: mocks.openWithDefault,
    openPathWithDefault: mocks.openPathWithDefault,
    openPathExternal: mocks.openPathExternal,
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
    mocks.openPathWithDefault.mockResolvedValue(undefined);
    mocks.openPathExternal.mockResolvedValue(undefined);
    mocks.checkPaths.mockResolvedValue({ results: {} });
    mocks.checkLocalPaths.mockResolvedValue({ results: {} });
    mocks.readPreview.mockResolvedValue({
      name: 'Message.tsx',
      content: 'export default function Message() {}',
      size: 36,
    });
    mocks.readLocalPreview.mockResolvedValue({
      name: 'Other.ts',
      content: 'export const other = true;',
      size: 26,
    });
  });

  it('opens workspace absolute path links in the MyAgents file preview instead of the system default app', async () => {
    const { onFilePreviewExternal } = renderMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx)`,
    );
    mocks.checkPaths.mockResolvedValue({
      results: { ['src/renderer/components/Message.tsx']: { exists: true, type: 'file' } },
    });

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
    mocks.checkPaths.mockResolvedValue({
      results: { ['src/renderer/components/Message.tsx']: { exists: true, type: 'file' } },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    await waitFor(() => {
      expect(onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
        path: 'src/renderer/components/Message.tsx',
        initialLineNumber: 42,
      }));
    });
  });

  it('previews real absolute local links outside the active workspace', async () => {
    const localPath = '/Users/zhihu/Other/Other.ts';
    mocks.checkLocalPaths.mockResolvedValue({
      results: { [localPath]: { exists: true, type: 'file' } },
    });
    const { onFilePreviewExternal } = renderMarkdown(`[Other.ts](${localPath})`);

    fireEvent.click(screen.getByRole('link', { name: 'Other.ts' }));

    await waitFor(() => {
      expect(onFilePreviewExternal).toHaveBeenCalledWith(expect.objectContaining({
        name: 'Other.ts',
        path: localPath,
        localPath,
        sourceScope: 'local',
        content: 'export const other = true;',
      }));
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.readPreview).not.toHaveBeenCalled();
  });

  it('opens non-previewable workspace links with the default app instead of swallowing the click', async () => {
    renderMarkdown(`[Archive](${WORKSPACE}/dist/archive.zip)`);
    mocks.checkPaths.mockResolvedValue({
      results: { ['dist/archive.zip']: { exists: true, type: 'file' } },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Archive' }));

    await waitFor(() => {
      expect(mocks.openWithDefault).toHaveBeenCalledWith({ path: 'dist/archive.zip' });
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('opens previewable workspace links through the floating-ball MyAgents preview bridge', async () => {
    renderFloatingMarkdown(
      `[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx:42)`,
    );
    mocks.checkPaths.mockResolvedValue({
      results: { ['src/renderer/components/Message.tsx']: { exists: true, type: 'file' } },
    });

    fireEvent.click(screen.getByRole('link', { name: 'Message.tsx' }));

    await waitFor(() => {
      expect(mocks.onOpenMyAgentsPreview).toHaveBeenCalledWith(
        'src/renderer/components/Message.tsx',
        {
          displayPath: `${WORKSPACE}/src/renderer/components/Message.tsx:42`,
          initialLineNumber: 42,
        },
      );
    });
    expect(mocks.readPreview).not.toHaveBeenCalled();
    expect(mocks.openWithDefault).not.toHaveBeenCalled();
  });

  it('opens the shared file menu on right-click for workspace Markdown file links', async () => {
    mocks.checkPaths.mockResolvedValue({
      results: { ['src/renderer/components/Message.tsx']: { exists: true, type: 'file' } },
    });
    renderMarkdown(`[Message.tsx](${WORKSPACE}/src/renderer/components/Message.tsx)`);

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Message.tsx' }));

    await screen.findByText('预览');
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['预览', '复制', '引用', '打开', '打开所在文件夹']);
  });

  it('right-clicks real local directories without offering preview', async () => {
    const localDir = '/Users/zhihu/Other';
    mocks.checkLocalPaths.mockResolvedValue({
      results: { [localDir]: { exists: true, type: 'dir' } },
    });
    renderMarkdown(`[Other](${localDir})`);

    fireEvent.contextMenu(screen.getByRole('link', { name: 'Other' }));

    await screen.findByText('复制');
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['复制', '引用', '打开', '打开所在文件夹']);
    expect(screen.queryByText('预览')).not.toBeInTheDocument();
  });
});
