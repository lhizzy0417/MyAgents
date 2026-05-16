// PRD 0.2.17 — Agent Status Panel
//
// 派生 hook：从 messages + 后台任务状态模块（backgroundTaskStatus）派生统一的
// AgentStatusState。**不引入新 SSE 事件**——所有数据都已存在于现有事件流和
// renderer 内存中。
//
// 后续接入外部 Runtime 时新增 mapper（如 mapCodexEvents → AgentStatusState），
// 消费侧组件不变（PRD §5.2）。

import { useEffect, useMemo, useState } from 'react';

import type { AgentInput, Message, TodoWriteInput } from '@/types/chat';
import {
  BACKGROUND_TASK_STATUS_EVENT,
  getBackgroundTaskStatus,
  isBackgroundTaskRegistered,
  isTerminalStatus,
} from '@/utils/backgroundTaskStatus';

import type { AgentStatusState, SubagentStatus, TodoItem } from './types';

// SDK TodoWriteOutput 形态（与 sdk-tools.d.ts:2450 对齐）。
// 不从 SDK import 是因为我们只需 newTodos 一个字段，且要避开 sidecar/renderer
// bundle 边界（renderer 已 import TodoWriteInput 类型即可）。
interface TodoWriteResultShape {
  newTodos?: TodoWriteInput['todos'];
}

function tryParseTodoResult(result: string | undefined): TodoWriteResultShape | null {
  if (!result) return null;
  try {
    return JSON.parse(result) as TodoWriteResultShape;
  } catch {
    return null;
  }
}

// 从历史 task-notification 消息抽出已完成的 BG toolUseId 集合。
// TabProvider 在 chat:task-notification 事件里 setHistoryMessages 注入一条
// id=`task-notification-{taskId}`, content=`<task-notification>{JSON}</task-notification>`
// 的 user message。JSON 包含 { taskId, toolUseId, status, summary, description }。
// 这条消息是持久化的（落 session.jsonl），比 renderer 进程级 backgroundTaskStatus
// 模块更可靠——Cmd+R 重载 / LRU 驱逐都不丢。是 B1 ship-blocker 的兜底防线。
function collectCompletedBgToolIdsFromHistory(messages: Message[]): Set<string> {
  const set = new Set<string>();
  for (const msg of messages) {
    if (!msg.id.startsWith('task-notification-')) continue;
    if (typeof msg.content !== 'string') continue;
    const match = msg.content.match(/<task-notification>([\s\S]+?)<\/task-notification>/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as { toolUseId?: string; status?: string };
      if (parsed.toolUseId && parsed.status) {
        set.add(parsed.toolUseId);
      }
    } catch {
      // 损坏的 notification 跳过，不影响其他判定
    }
  }
  return set;
}

/**
 * 从 messages 派生当前面板状态。
 *
 * @param messages — 当前 Tab 的完整消息列表（historyMessages + streamingMessage 合并后）
 *
 * 派生规则：
 * - todos：反向扫描，取最近一个 TodoWrite 工具的 result.newTodos（优先）或
 *   parsedInput.todos（fallback），忽略仍在 streaming、parsedInput 尚未成形的 TodoWrite
 *   （这样新 TodoWrite 在 streaming 期间显示旧状态，stop 后切换为新状态）。
 * - subagents（sync）：所有 isLoading 且未拿到 result 的 Task tool_use 块。
 * - subagents（background）：所有 run_in_background=true 的 Task tool_use 块，
 *   其 backgroundTaskStatus 状态未到 terminal 的视为仍在运行。
 */
export function useAgentStatusState(messages: Message[]): AgentStatusState {
  // 订阅后台任务状态变化，触发 useMemo 重算。
  const [bgEpoch, setBgEpoch] = useState(0);
  useEffect(() => {
    const handler = () => setBgEpoch(v => v + 1);
    window.addEventListener(BACKGROUND_TASK_STATUS_EVENT, handler);
    return () => window.removeEventListener(BACKGROUND_TASK_STATUS_EVENT, handler);
  }, []);

  return useMemo<AgentStatusState>(() => {
    let todos: TodoItem[] = [];
    const subagents: SubagentStatus[] = [];

    // B1 兜底：历史里所有 task-notification 消息里的 toolUseId 都视为已完成。
    const completedBgFromHistory = collectCompletedBgToolIdsFromHistory(messages);

    // 单次正序遍历：collect 所有候选 + 同步活跃 subagents + 后台 subagent 候选。
    // todos 取最后一个有效 TodoWrite。
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (typeof msg.content === 'string') continue;

      for (let j = 0; j < msg.content.length; j++) {
        const block = msg.content[j];
        if (block.type !== 'tool_use' || !block.tool) continue;
        const tool = block.tool;

        if (tool.name === 'TodoWrite') {
          // result 优先，input 作为 streaming-period fallback。
          const result = tryParseTodoResult(tool.result);
          const source = result?.newTodos
            ?? (tool.parsedInput as TodoWriteInput | undefined)?.todos;
          if (source && Array.isArray(source)) {
            todos = source.map((t, idx) => ({
              content: t.content,
              status: t.status,
              activeForm: t.activeForm,
              key: `${tool.id}-${idx}`,
            }));
          }
          continue;
        }

        if (tool.name === 'Task' || tool.name === 'Agent') {
          const input = tool.parsedInput as AgentInput | undefined;
          const isBackground = input?.run_in_background === true;

          if (isBackground) {
            // 后台任务过滤条件，三道防线（任一命中 → 视为已完成 → 跳过）：
            //   1. 历史里有对应 task-notification 消息（最可靠，扛 Cmd+R / LRU 驱逐）
            //   2. backgroundTaskStatus 模块里 status 是 terminal（运行期间正常完成路径）
            //   3. 模块里根本没注册过（要么没启动要么已被 LRU 驱逐 → 不应复活僵尸）
            if (completedBgFromHistory.has(tool.id)) continue;
            if (!isBackgroundTaskRegistered(tool.id)) continue;
            const status = getBackgroundTaskStatus(tool.id);
            if (isTerminalStatus(status)) continue;
            subagents.push(buildSubagentStatus(tool, input, 'background'));
          } else {
            // 同步任务：isLoading && !result 视为活跃。
            const isActive = !!tool.isLoading && !tool.result;
            if (!isActive) continue;
            subagents.push(buildSubagentStatus(tool, input, 'sync'));
          }
        }
      }
    }

    // 排序：同步在前（按 startedAt 升序），后台在后（按 startedAt 升序）。
    subagents.sort((a, b) => {
      if (a.mode !== b.mode) return a.mode === 'sync' ? -1 : 1;
      return a.startedAt - b.startedAt;
    });

    let completed = 0;
    let inProgress = 0;
    for (const t of todos) {
      if (t.status === 'completed') completed++;
      else if (t.status === 'in_progress') inProgress++;
    }
    // 取「最早开始」（startedAt 最小）= 跑得最久的那一个的 startedAt。
    // 注意不要在派生值里调 Date.now()——见 types.ts AgentStatusSummary 注释。
    const longestStartedAt = subagents.length === 0
      ? null
      : subagents.reduce((earliest, s) => (s.startedAt < earliest ? s.startedAt : earliest), subagents[0].startedAt);

    return {
      todos,
      subagents,
      summary: {
        todoCompleted: completed,
        todoInProgress: inProgress,
        todoTotal: todos.length,
        subagentRunning: subagents.length,
        longestSubagentStartedAt: longestStartedAt,
      },
    };
    // bgEpoch 在 deps 里仅为触发重算；其引用本身在闭包外不使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, bgEpoch]);
}

// 稳定 fallback startedAt：tool.taskStartTime 缺失时，记录首次见到此 toolId 的时间。
// 之前直接用 `?? Date.now()` 每次 useMemo 重算都会刷新成"现在"，elapsed 始终 0（Codex W4）。
const firstSeenAtByToolId = new Map<string, number>();

function buildSubagentStatus(
  tool: { id: string; taskStartTime?: number; taskStats?: { inputTokens: number; outputTokens: number; toolCount: number }; subagentCalls?: unknown[] },
  input: AgentInput | undefined,
  mode: 'sync' | 'background',
): SubagentStatus {
  let startedAt = tool.taskStartTime;
  if (startedAt === undefined) {
    const cached = firstSeenAtByToolId.get(tool.id);
    if (cached !== undefined) {
      startedAt = cached;
    } else {
      startedAt = Date.now();
      firstSeenAtByToolId.set(tool.id, startedAt);
    }
  }
  return {
    id: tool.id,
    agentType: input?.subagent_type ?? 'general-purpose',
    description: input?.description ?? '',
    mode,
    startedAt,
    inputTokens: tool.taskStats?.inputTokens ?? 0,
    outputTokens: tool.taskStats?.outputTokens ?? 0,
    toolCount: tool.taskStats?.toolCount ?? tool.subagentCalls?.length ?? 0,
  };
}
