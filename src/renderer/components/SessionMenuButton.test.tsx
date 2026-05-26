import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from './Toast';

const mocks = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  updateSession: vi.fn(),
  deactivateSession: vi.fn(),
  handoverSessionToChannel: vi.fn(),
  exportSessionAsMarkdown: vi.fn(),
}));

vi.mock('@/api/sessionClient', () => ({
  deleteSession: mocks.deleteSession,
  updateSession: mocks.updateSession,
}));

vi.mock('@/api/tauriClient', () => ({
  deactivateSession: mocks.deactivateSession,
}));

vi.mock('@/api/sessionHandoverClient', () => ({
  handoverSessionToChannel: mocks.handoverSessionToChannel,
}));

vi.mock('@/utils/sessionExport', () => ({
  exportSessionAsMarkdown: mocks.exportSessionAsMarkdown,
}));

import SessionMenuButton from './SessionMenuButton';

const SESSION_ID = '642ea003-5219-4af7-a812-a9812d6e79de';

function renderMenu() {
  return render(
    <ToastProvider>
      <SessionMenuButton
        sessionId={SESSION_ID}
        sessionTitle="Test session"
        workspacePath="/Users/zhihu/Documents/project/MyAgents"
        boundChannel={null}
        availableChannels={[]}
        cronProtected={false}
        favorite={false}
        canRename
        onOpenRename={vi.fn()}
        onFavoriteChanged={vi.fn()}
        onDeleted={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe('SessionMenuButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('shows a single-line SessionID row at the top of the menu', () => {
    renderMenu();

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));

    expect(screen.getByText('SessionID:')).toBeInTheDocument();
    expect(screen.getByText(SESSION_ID)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制 SessionID' })).toBeInTheDocument();
  });

  it('copies the AI-ready SessionID text', async () => {
    renderMenu();

    fireEvent.click(screen.getByRole('button', { name: '对话操作' }));
    fireEvent.click(screen.getByRole('button', { name: '复制 SessionID' }));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`SessionID: ${SESSION_ID}`);
    });
  });
});
