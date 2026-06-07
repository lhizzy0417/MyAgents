// Client-action slash commands
// ----------------------------------------------------------------------------
// Most slash commands either insert text into the input (and get sent to the
// AI, e.g. `/compact`) or are disk-backed skills/commands discovered by the
// Rust scanner. A *client-action* command is different: selecting it triggers
// a renderer-side UI action (e.g. opening the loop/cron panel) and is never
// sent to the AI.
//
// Such a command's behavior lives entirely in the renderer, so it is also
// *defined* and *injected* in the renderer (not registered in the Rust builtin
// list). It is only surfaced when the host wires an `onSlashAction` handler to
// service it — so it can never appear as a dead entry whose action can't run.
// This keeps the command and its action coupled by construction.

import type { SlashCommand } from '../../shared/slashCommands';

/** Built-in slash commands whose selection dispatches a renderer-side action. */
export const CLIENT_ACTION_SLASH_COMMANDS: SlashCommand[] = [
  { name: 'loop', description: '无限循环执行任务（Ralph Loop）', source: 'builtin' },
];

const CLIENT_ACTION_NAMES = new Set(CLIENT_ACTION_SLASH_COMMANDS.map((c) => c.name));

/** Whether selecting `cmd` should dispatch a client action instead of inserting text. */
export function isClientActionCommand(cmd: SlashCommand): boolean {
  return cmd.source === 'builtin' && CLIENT_ACTION_NAMES.has(cmd.name);
}

/**
 * Merge client-action commands into a fetched slash-command list.
 *
 * - `enabled` is false (no `onSlashAction` handler) → returns the list
 *   untouched so the command never appears where its action can't run.
 * - A command already present by name (e.g. a same-named user skill) is left
 *   as-is rather than duplicated; the existing entry wins, mirroring the Rust
 *   scanner's "first occurrence by name" dedup.
 */
export function withClientActionCommands(commands: SlashCommand[], enabled: boolean): SlashCommand[] {
  if (!enabled) return commands;
  const present = new Set(commands.map((c) => c.name));
  const extras = CLIENT_ACTION_SLASH_COMMANDS.filter((c) => !present.has(c.name));
  return extras.length === 0 ? commands : [...commands, ...extras];
}
