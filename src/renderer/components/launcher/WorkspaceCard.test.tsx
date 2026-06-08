import { render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/config/types';
import type { AgentConfig } from '../../../shared/types/agent';
import type { AgentStatusData } from '@/hooks/useAgentStatuses';

vi.mock('@/hooks/useCloseLayer', () => ({
    useCloseLayer: () => undefined,
}));

import WorkspaceCard from './WorkspaceCard';

const project: Project = {
    id: 'p1',
    name: 'Mino5',
    displayName: 'Mino5',
    path: '/Users/zhihu/.myagents/projects/Mino5',
    providerId: null,
    permissionMode: null,
    isAgent: true,
    agentId: 'agent-1',
};

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
    return {
        id: 'agent-1',
        name: 'Mino5',
        enabled: true,
        workspacePath: project.path,
        permissionMode: 'auto',
        channels: [],
        ...overrides,
    };
}

function renderCard(props: Partial<ComponentProps<typeof WorkspaceCard>> = {}) {
    return render(
        <WorkspaceCard
            project={project}
            agent={agent()}
            onLaunch={vi.fn()}
            onRemove={vi.fn()}
            onAgentSettings={vi.fn()}
            {...props}
        />,
    );
}

describe('WorkspaceCard', () => {
    it('does not show a pending chatbot setup hint when proactive Agent has no channels', () => {
        renderCard();

        expect(screen.getByText('Mino5')).toBeInTheDocument();
        expect(screen.queryByText('待配置聊天机器人')).not.toBeInTheDocument();
    });

    it('still renders channel status tags when channels exist', () => {
        const status: AgentStatusData = {
            agentId: 'agent-1',
            agentName: 'Mino5',
            enabled: true,
            channels: [{
                channelId: 'channel-1',
                channelType: 'telegram',
                status: 'online',
                uptimeSeconds: 12,
                activeSessions: [],
                restartCount: 0,
                bufferedMessages: 0,
            }],
        };

        renderCard({
            agent: agent({
                channels: [{
                    id: 'channel-1',
                    type: 'telegram',
                    enabled: true,
                    setupCompleted: true,
                }],
            }),
            agentStatus: status,
        });

        expect(screen.getByText('Telegram')).toBeInTheDocument();
    });
});
