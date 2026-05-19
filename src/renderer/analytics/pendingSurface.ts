/**
 * Pending Surface Registry
 *
 * 跨组件传递"下一个 session_new 事件应该带哪个 surface"。模型：
 *  - Caller（如 App.tsx::handleLaunchProject）在创建新 session 之前调用
 *    `setPendingSurface(tabId, 'agent_card')`。
 *  - Consumer（TabProvider::resetSession 或 chat:system-init handler）在
 *    track session_new 时调用 `consumePendingSurface(tabId, fallback)`。
 *  - 消费即清空——避免 stale surface 流入下一个 session_new。
 *
 * 为什么不用 React Context？session_new 的触发点跨组件（App ↔ TabProvider），
 * 而且有时是 SSE 事件回调里同步触发（不在 React 渲染循环里）。Module-level
 * Map 是最简单的"边界 IPC"——读写都是 O(1)，无 re-render 副作用。
 *
 * 设计要点：
 *  1. 默认值由 consumer 决定（不同 consumer 默认不同：resetSession 默认
 *     'new_chat_button'；chat:system-init 默认 'launcher_input'）
 *  2. tabId 隔离——Tab A 的 pending surface 不会被 Tab B 消费
 *  3. 消费即清空——避免泄漏到下一个 session_new
 *  4. 只在"即将创建新 session"前 set，不要在切换历史会话前 set（那条路径
 *     不触发 session_new，会让 surface 滞留）
 */

import type { Surface } from './types';

const pendingByTab = new Map<string, Surface>();

/**
 * 在 caller 即将创建新 session 之前打 surface。
 */
export function setPendingSurface(tabId: string, surface: Surface): void {
  pendingByTab.set(tabId, surface);
}

/**
 * Consumer 在 track session_new 之前消费 surface。如未 set 则返回 fallback。
 * 消费即清空，避免 stale 值流到下一个 session_new。
 */
export function consumePendingSurface(tabId: string, fallback: Surface): Surface {
  const v = pendingByTab.get(tabId);
  if (v !== undefined) {
    pendingByTab.delete(tabId);
    return v;
  }
  return fallback;
}

/**
 * Tab 关闭时调用，清掉残留。
 */
export function clearPendingSurface(tabId: string): void {
  pendingByTab.delete(tabId);
}
