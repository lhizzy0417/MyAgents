import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPaths: vi.fn(),
  openImagePreview: vi.fn(),
  openWithDefault: vi.fn(),
  openInFinder: vi.fn(),
  readPreview: vi.fn(),
  onInsertReference: vi.fn(),
  onOpenMyAgentsPreview: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('@/context/ImagePreviewContext', () => ({
  useImagePreview: () => ({ openPreview: mocks.openImagePreview }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => ({
    isAvailable: true,
    checkPaths: mocks.checkPaths,
    openWithDefault: mocks.openWithDefault,
    openInFinder: mocks.openInFinder,
    readPreview: mocks.readPreview,
    readFileAsBlobUrl: vi.fn(),
  }),
}));

import { FileActionProvider } from '@/context/FileActionContext';

import Markdown from './Markdown';

const WORKSPACE = '/Users/zhihu/Documents/project/mino';
const REL = '.claude/rules/04-MEMORY.md';
const ABS = `${WORKSPACE}/${REL}`;

function renderMarkdown(markdown: string) {
  render(
    <FileActionProvider workspacePath={WORKSPACE} onInsertReference={mocks.onInsertReference}>
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
  );
}

function renderFloatingMarkdown(markdown: string) {
  render(
    <FileActionProvider
      workspacePath={WORKSPACE}
      onInsertReference={mocks.onInsertReference}
      menuProfile="floatingBall"
      onOpenMyAgentsPreview={mocks.onOpenMyAgentsPreview}
    >
      <Markdown>{markdown}</Markdown>
    </FileActionProvider>,
  );
}

describe('Markdown inline-code file paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mocks.writeText },
      configurable: true,
    });
  });

  it('makes a workspace-relative path in backticks an interactive chip', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`v4 已存到 \`${REL}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL] });
    fireEvent.click(chip);
    expect(screen.getByText('预览')).toBeInTheDocument();
  });

  // Regression: an ABSOLUTE in-workspace path written in backticks used to stay
  // a plain <code> because the absolute form was sent straight to the Rust
  // resolver, which rejects absolute paths. The chip must DISPLAY the absolute
  // text but check existence against the workspace-relative form.
  it('normalizes an in-workspace absolute path in backticks before the existence check', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`见 \`${ABS}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(ABS);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    // Backend was hit with the relative form, never the absolute one.
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [REL] });
    expect(mocks.checkPaths).not.toHaveBeenCalledWith({ paths: [ABS] });
    // The chip still shows the original absolute text.
    expect(chip.getAttribute('title')).toBe(`文件: ${ABS}`);

    // 复制 copies the VERBATIM shown text (absolute here) — not the relative
    // action form the menu uses internally for backend calls.
    fireEvent.click(chip);
    fireEvent.click(screen.getByText('复制'));
    expect(mocks.writeText).toHaveBeenCalledWith(ABS);
  });

  it('leaves an absolute path OUTSIDE the workspace as plain code', async () => {
    const OUTSIDE = '/etc/hosts';
    mocks.checkPaths.mockResolvedValue({ results: {} });
    renderMarkdown(`见 \`${OUTSIDE}\` 。`);

    await waitFor(() => expect(mocks.checkPaths).toHaveBeenCalled());
    expect(mocks.checkPaths).toHaveBeenCalledWith({ paths: [OUTSIDE] });
    const chip = screen.getByText(OUTSIDE);
    expect(chip).not.toHaveClass('cursor-pointer');
  });

  it('offers 复制 below 预览 and copies the shown text verbatim', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderMarkdown(`v4 已存到 \`${REL}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    fireEvent.click(chip);

    // 复制 sits directly after 预览 in the menu.
    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['预览', '复制', '引用', '打开', '打开所在文件夹']);

    fireEvent.click(screen.getByText('复制'));
    // Copies exactly the shown text (relative here, as the model wrote it).
    expect(mocks.writeText).toHaveBeenCalledWith(REL);
  });

  it('uses the floating-ball four-action menu profile', async () => {
    mocks.checkPaths.mockResolvedValue({ results: { [REL]: { exists: true, type: 'file' } } });
    renderFloatingMarkdown(`v4 已存到 \`${REL}\` 。`);

    const chip = await waitFor(() => {
      const el = screen.getByText(REL);
      expect(el).toHaveClass('cursor-pointer');
      return el;
    });
    fireEvent.click(chip);

    const labels = screen.getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['复制', '引用', '打开所在文件夹', '打开 MyAgents 预览']);

    fireEvent.click(screen.getByText('打开 MyAgents 预览'));
    expect(mocks.onOpenMyAgentsPreview).toHaveBeenCalledWith(REL, { displayPath: REL });
  });
});
