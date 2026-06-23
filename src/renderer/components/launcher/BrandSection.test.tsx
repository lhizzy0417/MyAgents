import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { forwardRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { Project } from '@/config/types';

import BrandSection from './BrandSection';

vi.mock('@/components/SimpleChatInput', () => ({
  default: forwardRef<HTMLTextAreaElement>(function SimpleChatInputMock() {
    return <div data-testid="launcher-input">input</div>;
  }),
}));

vi.mock('@/components/cron/CronTaskSettingsModal', () => ({
  default: () => null,
}));

vi.mock('./LauncherInputContextRow', () => ({
  default: () => <div data-testid="launcher-context-row">context row</div>,
}));

vi.mock('@/components/task-center/ModeSegment', () => ({
  default: () => null,
}));

vi.mock('@/components/task-center/RecentThoughtsRow', () => ({
  default: () => null,
}));

vi.mock('@/components/task-center/ThoughtInput', () => ({
  ThoughtInput: forwardRef<HTMLTextAreaElement>(function ThoughtInputMock() {
    return <textarea aria-label="thought input" />;
  }),
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock('@/api/taskCenter', () => ({
  thoughtList: vi.fn(async () => []),
  taskCenterAvailable: () => false,
}));

vi.mock('@/hooks/useThoughtTagCandidates', () => ({
  useThoughtTagCandidates: () => [],
}));

const project: Project = {
  id: 'project-1',
  name: 'Project',
  path: '/Users/zhihu/project',
  providerId: null,
  permissionMode: null,
};

function renderBrandSection(overrides: Partial<ComponentProps<typeof BrandSection>> = {}) {
  const onGoToSettings = vi.fn();
  const view = render(
    <BrandSection
      projects={[project]}
      selectedProject={project}
      onSelectWorkspace={vi.fn()}
      onAddFolder={vi.fn()}
      onSend={vi.fn()}
      providers={[]}
      apiKeys={{}}
      providerVerifyStatus={{}}
      onGoToSettings={onGoToSettings}
      {...overrides}
    />,
  );
  return { ...view, onGoToSettings };
}

describe('BrandSection', () => {
  it('keeps the no-provider settings CTA in the same below-input stack as the launcher context row', () => {
    const { container } = renderBrandSection();

    const stack = container.querySelector('.launcher-below-input-stack');

    expect(stack).not.toBeNull();
    expect(screen.getByTestId('launcher-context-row')).toBeInTheDocument();
    expect(stack as HTMLElement).toContainElement(screen.getByTestId('launcher-context-row'));
    expect(stack as HTMLElement).toContainElement(screen.getByRole('button', { name: /配置模型供应商/ }));
  });

  it('opens provider settings from the no-provider CTA', () => {
    const { onGoToSettings } = renderBrandSection();

    fireEvent.click(screen.getByRole('button', { name: /配置模型供应商/ }));

    expect(onGoToSettings).toHaveBeenCalledTimes(1);
  });
});
