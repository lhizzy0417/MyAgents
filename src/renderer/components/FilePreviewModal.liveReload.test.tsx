import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import FilePreviewModal, {
  decideLiveReload,
  formatFilePreviewUpdateTime,
} from './FilePreviewModal';

const mocks = vi.hoisted(() => ({
  readPreview: vi.fn(),
  saveFile: vi.fn(),
  rename: vi.fn(),
  openInFinder: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    readPreview: mocks.readPreview,
    saveFile: mocks.saveFile,
    rename: mocks.rename,
    openInFinder: mocks.openInFinder,
  }),
}));

vi.mock('@/hooks/useWorkspaceChangeSignal', () => ({
  useWorkspaceChangeSignal: () => 0,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    showToast: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    warning: mocks.toastWarning,
    info: vi.fn(),
  }),
}));

vi.mock('./Tip', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('./Markdown', () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="markdown-preview">{children}</div>
  ),
}));

vi.mock('./MonacoEditor', () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="monaco-editor"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

const baseProps = {
  name: 'notes.md',
  content: 'old content',
  size: 11,
  path: 'notes.md',
  workspacePath: '/workspace',
  embedded: true,
  onClose: vi.fn(),
};

describe('FilePreviewModal live reload', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('re-reads the open markdown file in place and shows a subtle update timestamp', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'new content',
      size: 11,
    });
    const onExternalContentUpdated = vi.fn();

    const { container, rerender } = render(
      <FilePreviewModal
        {...baseProps}
        externalRefreshSignal={0}
        onExternalContentUpdated={onExternalContentUpdated}
      />,
    );

    expect(screen.getByTestId('markdown-preview')).toHaveTextContent('old content');

    const scroller = container.querySelector('.overflow-auto') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    scroller.scrollTop = 360;

    rerender(
      <FilePreviewModal
        {...baseProps}
        externalRefreshSignal={1}
        onExternalContentUpdated={onExternalContentUpdated}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('markdown-preview')).toHaveTextContent('new content');
    });
    expect(onExternalContentUpdated).toHaveBeenCalledWith({
      path: 'notes.md',
      name: 'notes.md',
      content: 'new content',
      size: 11,
    });
    expect(screen.getByText(/^已更新 \d{2}:\d{2}$/)).toBeTruthy();
    expect(scroller.scrollTop).toBe(360);
  });

  it('revalidates on first mount when an external refresh signal already happened', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'fresh after hidden update',
      size: 25,
    });

    render(
      <FilePreviewModal
        {...baseProps}
        externalRefreshSignal={3}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('markdown-preview')).toHaveTextContent('fresh after hidden update');
    });
    expect(mocks.readPreview).toHaveBeenCalledWith({ path: 'notes.md' });
  });

  it('does not autosave a dirty local buffer over an external update', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });

    const { rerender } = render(
      <FilePreviewModal {...baseProps} initialEditMode externalRefreshSignal={0} />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    rerender(
      <FilePreviewModal {...baseProps} initialEditMode externalRefreshSignal={1} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });

    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(editor.value).toBe('local dirty content');
    expect(mocks.saveFile).not.toHaveBeenCalled();
  });

  it('passes the saved baseline to autosave and converts stale-save failures into external-update pending', async () => {
    mocks.saveFile.mockRejectedValueOnce(new Error('File changed externally'));
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });

    render(
      <FilePreviewModal {...baseProps} initialEditMode externalRefreshSignal={0} />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    await waitFor(() => {
      expect(mocks.saveFile).toHaveBeenCalledWith({
        path: 'notes.md',
        content: 'local dirty content',
        expectedContent: 'old content',
      });
    }, { timeout: 1500 });

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });
    expect(editor.value).toBe('local dirty content');
  });

  it('does not enter fullscreen while a dirty external-update conflict is pending', async () => {
    mocks.readPreview.mockResolvedValueOnce({
      name: 'notes.md',
      content: 'external content',
      size: 16,
    });
    const onFullscreen = vi.fn();

    const { rerender } = render(
      <FilePreviewModal
        {...baseProps}
        initialEditMode
        externalRefreshSignal={0}
        onFullscreen={onFullscreen}
      />,
    );

    const editor = await screen.findByTestId('monaco-editor') as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: 'local dirty content' } });

    rerender(
      <FilePreviewModal
        {...baseProps}
        initialEditMode
        externalRefreshSignal={1}
        onFullscreen={onFullscreen}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/^外部更新 \d{2}:\d{2}$/)).toBeTruthy();
    });

    const iconButtons = screen.getAllByRole('button').filter((button) => !button.textContent?.trim());
    fireEvent.click(iconButtons[0]);

    expect(onFullscreen).not.toHaveBeenCalled();
    expect(mocks.toastWarning).toHaveBeenCalledWith('文件已在外部更新，未自动覆盖');
  });
});

describe('FilePreviewModal live reload helpers', () => {
  it('formats update time as HH:mm', () => {
    expect(formatFilePreviewUpdateTime(new Date(2026, 5, 6, 3, 4))).toBe('03:04');
  });

  it('does not overwrite dirty editable content on external reload', () => {
    expect(decideLiveReload({
      incomingContent: 'external',
      currentContent: 'local dirty',
      savedContent: 'old saved',
      canEdit: true,
    })).toBe('pending');
  });

  it('applies external content when the visible buffer is clean', () => {
    expect(decideLiveReload({
      incomingContent: 'external',
      currentContent: 'old saved',
      savedContent: 'old saved',
      canEdit: true,
    })).toBe('apply');
  });
});
