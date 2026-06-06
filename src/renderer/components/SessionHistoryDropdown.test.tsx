import { createRef } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionMetadata } from '@/api/sessionClient';
import { ToastProvider } from './Toast';

// SessionHistoryDropdown's per-row hover toolbar collapsed from 4 buttons
// (收藏/导出/统计/删除) down to just "在新 tab 打开" + a "更多" overflow menu
// that holds the rest. These tests pin that structure so a refactor can't
// silently put a low-frequency action back on the row or drop the new-tab one.

const mocks = vi.hoisted(() => ({
    getSessions: vi.fn(),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    deactivateSession: vi.fn(),
    exportSessionAsMarkdown: vi.fn(),
    getWorkspaceCronTasks: vi.fn(),
    getBackgroundSessions: vi.fn(),
}));

vi.mock('@/api/sessionClient', () => ({
    getSessions: mocks.getSessions,
    updateSession: mocks.updateSession,
    deleteSession: mocks.deleteSession,
}));
vi.mock('@/api/tauriClient', () => ({ deactivateSession: mocks.deactivateSession }));
vi.mock('@/utils/sessionExport', () => ({ exportSessionAsMarkdown: mocks.exportSessionAsMarkdown }));
vi.mock('@/api/cronTaskClient', () => ({
    getWorkspaceCronTasks: mocks.getWorkspaceCronTasks,
    getBackgroundSessions: mocks.getBackgroundSessions,
}));
// Stay in browser mode: skips the Tauri invoke/listen branches entirely.
vi.mock('@/utils/browserMock', () => ({ isTauriEnvironment: () => false }));
vi.mock('@/utils/tauriListen', () => ({ listenWithCleanup: vi.fn() }));

import SessionHistoryDropdown from './SessionHistoryDropdown';

const SESSION: SessionMetadata = {
    id: 'd1f5c0a2-0000-4000-8000-000000000001',
    agentDir: '/ws',
    title: 'My session',
    createdAt: '2026-06-01T00:00:00.000Z',
    lastActiveAt: '2026-06-06T08:00:00.000Z',
};

function renderDropdown(onOpenInNewTab?: (id: string, title: string) => void) {
    const triggerRef = createRef<HTMLButtonElement>();
    const onClose = vi.fn();
    render(
        <ToastProvider>
            <button ref={triggerRef}>历史</button>
            <SessionHistoryDropdown
                agentDir="/ws"
                currentSessionId={null}
                onSelectSession={vi.fn()}
                onOpenInNewTab={onOpenInNewTab}
                onDeleteCurrentSession={vi.fn()}
                isOpen
                onClose={onClose}
                triggerRef={triggerRef}
            />
        </ToastProvider>,
    );
    return { onClose };
}

describe('SessionHistoryDropdown row actions', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessions.mockResolvedValue([SESSION]);
        mocks.getWorkspaceCronTasks.mockResolvedValue([]);
        mocks.getBackgroundSessions.mockResolvedValue([]);
        mocks.updateSession.mockResolvedValue({ ...SESSION, favorite: true });
    });

    it('surfaces only 在新 tab 打开 + 更多 on the row; the rest live behind 更多', async () => {
        renderDropdown(vi.fn());
        await screen.findByText('My session');

        // Surfaced toolbar actions.
        expect(screen.getByRole('button', { name: '在新 tab 打开' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();

        // The low-frequency actions are NOT on the row until 更多 is opened.
        expect(screen.queryByText('收藏对话')).toBeNull();
        expect(screen.queryByText('导出为 md 文件')).toBeNull();
        expect(screen.queryByText('查看统计')).toBeNull();
        expect(screen.queryByText('删除对话')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: '更多操作' }));

        expect(screen.getByText('收藏对话')).toBeInTheDocument();
        expect(screen.getByText('导出为 md 文件')).toBeInTheDocument();
        expect(screen.getByText('查看统计')).toBeInTheDocument();
        expect(screen.getByText('删除对话')).toBeInTheDocument();
    });

    it('opens a session in a new tab and closes the dropdown', async () => {
        const onOpenInNewTab = vi.fn();
        const { onClose } = renderDropdown(onOpenInNewTab);
        await screen.findByText('My session');

        fireEvent.click(screen.getByRole('button', { name: '在新 tab 打开' }));

        expect(onOpenInNewTab).toHaveBeenCalledWith(SESSION.id, 'My session');
        expect(onClose).toHaveBeenCalled();
    });

    it('hides 在新 tab 打开 when no handler is wired (e.g. settings helper inbox)', async () => {
        renderDropdown(undefined);
        await screen.findByText('My session');

        expect(screen.queryByRole('button', { name: '在新 tab 打开' })).toBeNull();
        // 更多 still present so the actions remain reachable.
        expect(screen.getByRole('button', { name: '更多操作' })).toBeInTheDocument();
    });

    it('toggles favorite from the 更多 menu', async () => {
        renderDropdown(vi.fn());
        await screen.findByText('My session');

        fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
        fireEvent.click(screen.getByText('收藏对话'));

        await waitFor(() => {
            expect(mocks.updateSession).toHaveBeenCalledWith(SESSION.id, { favorite: true });
        });
    });
});
