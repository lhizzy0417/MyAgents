import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';
import type { Provider } from '@/config/types';
import SimpleChatInput, { type SimpleChatInputHandle } from './SimpleChatInput';
import { ToastProvider } from './Toast';

const workspaceMocks = vi.hoisted(() => ({
  service: {
    isAvailable: true,
    importBase64Files: vi.fn(),
    copyPaths: vi.fn(),
    addGitignore: vi.fn(),
    prepareUserImageAttachments: vi.fn(),
    searchFiles: vi.fn(),
    listSlashCommands: vi.fn(),
  },
}));

vi.mock('@/config/useConfigData', () => ({
  useConfigData: () => ({ config: { chatSendShortcut: 'enter' } }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
  useWorkspaceFileService: () => workspaceMocks.service,
}));

function renderInput(props: Partial<React.ComponentProps<typeof SimpleChatInput>> = {}) {
  const onSend = vi.fn();
  render(
    <ToastProvider>
      <ImagePreviewProvider>
        <SimpleChatInput
          runtime="codex"
          isLoading={false}
          onSend={onSend}
          {...props}
        />
      </ImagePreviewProvider>
    </ToastProvider>,
  );
  return onSend;
}

describe('SimpleChatInput send paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceMocks.service.importBase64Files.mockResolvedValue({
      success: true,
      files: ['myagents_files/pasted.txt'],
    });
    workspaceMocks.service.copyPaths.mockResolvedValue({
      success: true,
      copiedFiles: [{ targetPath: 'myagents_files/report.pdf' }],
    });
    workspaceMocks.service.addGitignore.mockResolvedValue({ success: true });
    workspaceMocks.service.searchFiles.mockResolvedValue([]);
    workspaceMocks.service.listSlashCommands.mockResolvedValue([]);
  });

  it('sends text from the Chat input surface', async () => {
    const user = userEvent.setup();
    const onSend = renderInput();

    const textarea = screen.getByPlaceholderText('输入消息，使用 @ 引用文件，/ 使用技能...');
    await user.type(textarea, 'chat hello');
    await user.click(screen.getByTitle(/发送/));

    expect(onSend).toHaveBeenCalledWith('chat hello', undefined);
  });

  it('emits provider-scoped builtin model selections from the model menu', async () => {
    const user = userEvent.setup();
    const onBuiltinModelSelect = vi.fn();
    const onModelChange = vi.fn();
    const providers = [
      {
        id: 'provider-a',
        name: 'Provider A',
        vendor: 'A',
        cloudProvider: '模型官方',
        type: 'api',
        primaryModel: 'deepseek-v4-pro',
        isBuiltin: false,
        config: { baseUrl: 'https://a.example.com' },
        models: [{ model: 'deepseek-v4-pro', modelName: 'A Pro' }],
      },
      {
        id: 'provider-b',
        name: 'Provider B',
        vendor: 'B',
        cloudProvider: '模型官方',
        type: 'api',
        primaryModel: 'deepseek-v4-pro',
        isBuiltin: false,
        config: { baseUrl: 'https://b.example.com' },
        models: [{ model: 'deepseek-v4-pro', modelName: 'B Pro' }],
      },
    ] as Provider[];

    renderInput({
      runtime: 'builtin',
      provider: providers[0],
      providers,
      selectedModel: 'deepseek-v4-pro',
      apiKeys: { 'provider-a': 'key-a', 'provider-b': 'key-b' },
      onBuiltinModelSelect,
      onModelChange,
    });

    await user.click(screen.getByTitle('切换模型'));
    await user.click(await screen.findByText('B Pro'));

    expect(onBuiltinModelSelect).toHaveBeenCalledWith({
      providerId: 'provider-b',
      model: 'deepseek-v4-pro',
    });
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('sends text from the Launcher input surface', async () => {
    const user = userEvent.setup();
    const onSend = renderInput({ mode: 'launcher' });

    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    await user.type(textarea, 'launcher hello');
    await user.click(screen.getByTitle(/发送/));

    expect(onSend).toHaveBeenCalledWith('launcher hello', undefined);
  });

  it('accepts pasted image attachments without routing through workspace file IO for external runtimes', async () => {
    renderInput({ mode: 'launcher' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const image = new File(['png'], 'clip.png', { type: 'image/png' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => image,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByAltText('attachment')).toBeInTheDocument());
    expect(workspaceMocks.service.importBase64Files).not.toHaveBeenCalled();
    expect(workspaceMocks.service.copyPaths).not.toHaveBeenCalled();
    expect(workspaceMocks.service.prepareUserImageAttachments).not.toHaveBeenCalled();
  });

  it('pastes non-image attachments as workspace file references', async () => {
    renderInput({ mode: 'launcher', workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const file = new File(['hello'], 'pasted.txt', { type: 'text/plain' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(textarea).toHaveValue('@myagents_files/pasted.txt '));
    expect(workspaceMocks.service.importBase64Files).toHaveBeenCalledWith({
      files: [{ name: 'pasted.txt', content: expect.any(String) }],
      targetDir: 'myagents_files',
    });
  });

  it('preserves text typed while a pasted file import is still pending', async () => {
    const user = userEvent.setup();
    let resolveImport!: (value: { success: boolean; files: string[] }) => void;
    workspaceMocks.service.importBase64Files.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveImport = resolve;
      }),
    );

    renderInput({ mode: 'launcher', workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');
    const file = new File(['hello'], 'pasted.txt', { type: 'text/plain' });

    fireEvent.paste(textarea, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(workspaceMocks.service.importBase64Files).toHaveBeenCalled());
    await user.type(textarea, 'keep me');

    await act(async () => {
      resolveImport({ success: true, files: ['myagents_files/pasted.txt'] });
    });

    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toContain('keep me');
      expect((textarea as HTMLTextAreaElement).value).toContain('@myagents_files/pasted.txt');
    });
  });

  it('copies dropped filesystem paths as workspace file references through the imperative handle', async () => {
    const ref = createRef<SimpleChatInputHandle>();
    renderInput({ mode: 'launcher', ref, workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    await act(async () => {
      const handle = ref.current;
      if (!handle?.processDroppedFilePaths) throw new Error('SimpleChatInput ref was not mounted');
      await handle.processDroppedFilePaths(['/tmp/report.pdf']);
    });

    await waitFor(() => expect(textarea).toHaveValue('@myagents_files/report.pdf '));
    expect(workspaceMocks.service.copyPaths).toHaveBeenCalledWith({
      sourcePaths: ['/tmp/report.pdf'],
      targetDir: 'myagents_files',
      autoRename: true,
    });
  });

  it('preserves text typed while a dropped path copy is still pending', async () => {
    const user = userEvent.setup();
    const ref = createRef<SimpleChatInputHandle>();
    let resolveCopy!: (value: { success: boolean; copiedFiles: Array<{ targetPath: string }> }) => void;
    workspaceMocks.service.copyPaths.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCopy = resolve;
      }),
    );

    renderInput({ mode: 'launcher', ref, workspacePath: '/workspace' });
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    const handle = ref.current;
    if (!handle?.processDroppedFilePaths) throw new Error('SimpleChatInput ref was not mounted');
    const copyPromise = handle.processDroppedFilePaths(['/tmp/report.pdf']);
    await waitFor(() => expect(workspaceMocks.service.copyPaths).toHaveBeenCalled());
    await user.type(textarea, 'keep me');

    await act(async () => {
      resolveCopy({ success: true, copiedFiles: [{ targetPath: 'myagents_files/report.pdf' }] });
      await copyPromise;
    });

    await waitFor(() => {
      expect((textarea as HTMLTextAreaElement).value).toContain('keep me');
      expect((textarea as HTMLTextAreaElement).value).toContain('@myagents_files/report.pdf');
    });
  });
});
