import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from '@/components/Toast';
import type { SessionMetadata } from '@/api/sessionClient';
import type { Project } from '@/config/types';
import type { TaskCenterData } from '@/hooks/useTaskCenterData';

import LauncherRightRail from './LauncherRightRail';

vi.mock('@/components/SessionStatsModal', () => ({
    default: ({ sessionId }: { sessionId: string }) => (
        <div role="dialog" aria-label="session stats">
            stats:{sessionId}
        </div>
    ),
}));

function project(index: number): Project {
    return {
        id: `p${index}`,
        name: `Project ${index}`,
        displayName: index === 1 ? 'MyAgents' : `Project ${index}`,
        path: `/Users/zhihu/Documents/project/project-${index}`,
        providerId: null,
        permissionMode: null,
        isAgent: index === 1,
        agentId: index === 1 ? 'agent-1' : undefined,
    };
}

function session(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
    return {
        id: 's1',
        agentDir: project(1).path,
        title: 'Session A',
        createdAt: '2026-06-20T00:00:00.000Z',
        lastActiveAt: '2026-06-20T00:19:00.000Z',
        ...overrides,
    };
}

function taskCenterData(sessions: SessionMetadata[]): TaskCenterData {
    return {
        sessions,
        cronTasks: [],
        tasks: [],
        sessionTagsMap: new Map(),
        cronBotInfoMap: new Map(),
        isLoading: false,
        error: null,
        refresh: vi.fn(),
        actions: {
            deleteSession: vi.fn(async () => true),
            refreshSessions: vi.fn(),
            refreshCronTasks: vi.fn(),
            refreshTasks: vi.fn(),
        },
    };
}

function renderRail(options: {
    projects?: Project[];
    sessions?: SessionMetadata[];
    onOpenTask?: ReturnType<typeof vi.fn>;
} = {}) {
    const projects = options.projects ?? [project(1), project(2), project(3), project(4)];
    const onOpenTask = options.onOpenTask ?? vi.fn();
    const view = render(
        <ToastProvider>
            <LauncherRightRail
                projects={projects}
                agentLookup={new Map()}
                isProjectsLoading={false}
                launchingProjectId={null}
                taskCenterData={taskCenterData(options.sessions ?? [session()])}
                onLaunch={vi.fn()}
                onOpenTask={onOpenTask}
                onOpenOverlay={vi.fn()}
                onRemoveProject={vi.fn()}
                onAgentSettings={vi.fn()}
                onToggleProjectPin={vi.fn()}
                onAddFolder={vi.fn()}
                onCreateFromTemplate={vi.fn()}
                onShowLogs={vi.fn()}
            />
        </ToastProvider>,
    );
    return { ...view, onOpenTask };
}

describe('LauncherRightRail', () => {
    beforeEach(() => {
        Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
            configurable: true,
            value: vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions) {
                this.scrollTop = options.top ?? 0;
            }),
        });
    });

    it('collapses workspaces immediately and returns the right rail to the top', () => {
        const projects = [project(1), project(2), project(3), project(4), project(5), project(6)];
        const { container } = renderRail({ projects });
        const scrollRoot = container.querySelector('.launcher-workspaces > div') as HTMLDivElement;

        fireEvent.click(screen.getByRole('button', { name: /展开更多 2 个/ }));
        expect(screen.getByText('Project 6')).toBeInTheDocument();

        scrollRoot.scrollTop = 420;
        fireEvent.click(screen.getByRole('button', { name: /收起/ }));

        expect(screen.getByRole('button', { name: /展开更多 2 个/ })).toBeInTheDocument();
        expect(screen.queryByText('Project 6')).not.toBeInTheDocument();
        expect(scrollRoot.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
    });

    it('does not open the history session when a row menu action is clicked', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '查看统计' }));

        expect(onOpenTask).not.toHaveBeenCalled();
        expect(screen.getByRole('dialog', { name: 'session stats' })).toHaveTextContent('stats:stats-session');
    });

    it('does not open the history session from row menu keyboard activation keys', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        const moreButton = within(row).getByLabelText('更多');
        fireEvent.keyDown(moreButton, { key: 'Enter' });
        fireEvent.click(moreButton);
        const statsItem = screen.getByRole('button', { name: '查看统计' });

        fireEvent.keyDown(statsItem, { key: 'Enter' });
        fireEvent.keyDown(statsItem, { key: ' ' });

        expect(onOpenTask).not.toHaveBeenCalled();
    });

    it('does not open the history session when clicking row menu padding', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'stats-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        const popover = screen.getByRole('button', { name: '查看统计' }).parentElement as HTMLElement;

        fireEvent.click(popover);

        expect(onOpenTask).not.toHaveBeenCalled();
    });

    it('opens delete confirmation without opening the history session', () => {
        const onOpenTask = vi.fn();
        renderRail({ onOpenTask, sessions: [session({ id: 'delete-session', title: 'Session A' })] });

        const row = screen.getByRole('button', { name: /Session A/ });
        fireEvent.click(within(row).getByLabelText('更多'));
        fireEvent.click(screen.getByRole('button', { name: '删除' }));

        expect(onOpenTask).not.toHaveBeenCalled();
        expect(screen.getByText('删除对话')).toBeInTheDocument();
    });
});
