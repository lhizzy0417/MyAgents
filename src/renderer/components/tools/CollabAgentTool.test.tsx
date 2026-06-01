// PRD 0.2.27 — Codex collab-agent (sub-agent) nesting renders via the existing
// TaskTool container + label helpers. These guard the frontend wiring that lets
// a 'CollabAgent' card behave like a builtin 'Task' card (expandable nested trace).

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';

import type { ToolUseSimple } from '@/types/chat';

import TaskTool from './TaskTool';
import { getToolLabel, getToolMainLabel, isSubagentContainerTool } from './toolBadgeConfig';

afterEach(() => cleanup());

function collabTool(overrides: Partial<ToolUseSimple>): ToolUseSimple {
  return {
    id: 'card-1',
    name: 'CollabAgent',
    input: { tool: 'spawnAgent', prompt: 'henan worker', model: 'gpt-5-codex' },
    parsedInput: { tool: 'spawnAgent', prompt: 'henan worker', model: 'gpt-5-codex' } as unknown as ToolUseSimple['parsedInput'],
    streamIndex: 0,
    ...overrides,
  };
}

describe('isSubagentContainerTool', () => {
  it('treats builtin Task/Agent and Codex CollabAgent as sub-agent containers', () => {
    expect(isSubagentContainerTool('Task')).toBe(true);
    expect(isSubagentContainerTool('Agent')).toBe(true);
    expect(isSubagentContainerTool('CollabAgent')).toBe(true);
  });
  it('rejects ordinary tools', () => {
    expect(isSubagentContainerTool('Bash')).toBe(false);
    expect(isSubagentContainerTool('TaskCreate')).toBe(false); // the todo tool, not a container
  });
});

describe('CollabAgent labels', () => {
  it('main label is a stable "Sub-agent"', () => {
    expect(getToolMainLabel(collabTool({}))).toBe('Sub-agent');
  });
  it('compact label reflects the collab action + model', () => {
    expect(getToolLabel(collabTool({}))).toBe('派生子 Agent · gpt-5-codex');
  });
  it('compact label shows the latest sub-agent call while running', () => {
    const label = getToolLabel(collabTool({
      isLoading: true,
      subagentCalls: [{ id: 't1', name: 'Bash', input: { command: 'ls' }, isLoading: true }],
    }));
    // getSubagentCallLabel(Bash with command) → first part of the command
    expect(label).toBe('ls');
  });
});

describe('TaskTool renders a CollabAgent card with a nested trace', () => {
  it('exposes a reachable trace toggle that reveals the sub-agent tool calls', () => {
    const { container } = render(<TaskTool tool={collabTool({
      result: 'Tool: spawnAgent\nPrompt: henan worker', // non-JSON collab summary
      isLoading: false,
      subagentCalls: [
        { id: 't1', name: 'Bash', input: { command: 'python3 validate.py' }, result: 'ok', isLoading: false },
        { id: 't2', name: 'WebSearch', input: { query: 'henan gaokao' }, result: 'done', isLoading: false },
      ],
    })} />);

    // The spawn prompt is shown.
    expect(screen.getAllByText(/henan worker/).length).toBeGreaterThan(0);

    // Trace is collapsed initially; the toggle is reachable (NOT buried where a
    // non-JSON-result collab card would otherwise have no stats bar at all).
    const toggle = container.querySelector('[aria-controls="task-trace-content"]');
    expect(toggle).not.toBeNull();

    // Expanding reveals each sub-agent tool by name.
    fireEvent.click(toggle!);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('WebSearch')).toBeInTheDocument();
  });

  it('renders a leaf collab card (no trace) without crashing', () => {
    render(<TaskTool tool={collabTool({
      input: { tool: 'wait' },
      parsedInput: { tool: 'wait' } as unknown as ToolUseSimple['parsedInput'],
      result: 'Tool: wait',
      isLoading: false,
    })} />);
    expect(screen.getByText(/Tool: wait/)).toBeInTheDocument();
  });
});
