// TaskAdvancedConfigEditor — collapsible "高级配置" block shared by the
// task dispatch dialog and the task edit panel.
//
// Default semantics: every field is `undefined` (== "跟随 Agent 工作区当前
// 配置"). The user opts in per field by picking a concrete value, which
// snapshots that value onto the Task. PRD 0.2.4 §需求 4.
//
// Permission-mode default has special meaning: when left at "跟随默认", the
// task executor uses the runtime's *maximum* permission (e.g. SDK builtin
// → bypassPermissions). This is intentional — task dispatch is unattended
// by definition, so a task that lands in `auto` mode would block at the
// first tool call waiting for confirmation that nobody is around to give.
// The cron execute path has long hardcoded `'fullAgency'` for this reason
// (see `src/server/index.ts` `/cron/execute`); the field surfaced here is
// the user-facing escape hatch when they want a stricter mode.

import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';
import CustomSelect from '@/components/CustomSelect';
import { useConfig } from '@/hooks/useConfig';
import {
  RUNTIME_DISPLAY_NAMES,
  VALID_RUNTIMES,
  getRuntimePermissionModes,
  type RuntimeType,
} from '@/../shared/types/runtime';
import type { McpServerDefinition } from '@/config/types';
import { getAllMcpServersFromConfig } from '@/config/services/mcpService';

// "跟随" sentinel: an empty-string value selected from <CustomSelect>
// translates back to `undefined` on the wrapper level. Using `''` rather
// than a different sentinel keeps the option compatible with the existing
// `<CustomSelect value={…}>` contract (which doesn't tolerate `undefined`).
const FOLLOW_VALUE = '';

interface Props {
  /** Workspace path the task is bound to — used to resolve the workspace's
   *  Agent (runtime / model / MCP defaults) and provider (model picker).
   *  Display name for hint copy is derived internally from the resolved
   *  project so callers don't need to thread it through separately. */
  workspacePath?: string;

  // ─── Runtime / model / permission mode ───────────────────────────────
  runtime?: RuntimeType;
  setRuntime: (v: RuntimeType | undefined) => void;
  model?: string;
  setModel: (v: string | undefined) => void;
  permissionMode?: string;
  setPermissionMode: (v: string | undefined) => void;

  // ─── MCP enable list ─────────────────────────────────────────────────
  /** `undefined` = follow Agent. `[]` = explicitly run with no MCP servers. */
  mcpEnabledServers?: string[];
  setMcpEnabledServers: (v: string[] | undefined) => void;
}

export function TaskAdvancedConfigEditor(props: Props) {
  const {
    workspacePath,
    runtime,
    setRuntime: setRuntimeRaw,
    model,
    setModel,
    permissionMode,
    setPermissionMode,
    mcpEnabledServers,
    setMcpEnabledServers,
  } = props;

  // Default-collapsed; expand state is local to the panel lifecycle.
  // Auto-expand if any value is already set (so "edit existing override"
  // doesn't hide what the user previously configured).
  const hasAnyOverride =
    runtime !== undefined
    || (model && model.length > 0)
    || (permissionMode && permissionMode.length > 0)
    || mcpEnabledServers !== undefined;
  const [open, setOpen] = useState<boolean>(hasAnyOverride);

  const { config, projects, providers } = useConfig();

  // Resolve the workspace's Agent — source of truth for the runtime / model
  // / permission / MCP defaults that the task inherits when the user picks
  // "跟随 Agent". Mirrors WorkspaceBasicsSection: when the Agent uses an
  // external runtime (Claude Code CLI / Codex / Gemini), the entire below
  // panel is hidden because external runtimes manage their own model /
  // permission / MCP via their own CLI flags.
  const workspaceAgent = useMemo(() => {
    if (!workspacePath) return null;
    return config?.agents?.find((a) => a.workspacePath === workspacePath) ?? null;
  }, [workspacePath, config]);

  // Multi-Agent Runtime feature gate (Settings → 实验室). When OFF, this editor
  // behaves as if external runtimes don't exist:
  //   - Runtime selector is hidden entirely
  //   - effectiveRuntime is forced to 'builtin' for THIS UI's purposes, so
  //     model/permission/MCP fields render as the builtin variant regardless
  //     of what's persisted on `runtime` / `workspaceAgent.runtime`
  //   - Persisted values on disk (`task.runtime`, `agent.runtime`) are NOT
  //     touched — flipping the gate back on restores the prior selection,
  //     matching the round-trip semantics in Chat / Launcher / Agent settings.
  // The single residual gap: a task with `runtime='claude-code'` saved when
  // the gate was on will still spawn an external runtime sidecar at cron
  // execution time even with the gate off, because that path is in Rust and
  // doesn't read the gate. Acceptable until the gate is removed entirely
  // (planned for a few versions out — at which point external runtimes are
  // universally available and the behavior becomes correct by definition).
  const multiAgentRuntimeEnabled = !!config?.multiAgentRuntime;

  // Effective runtime that this task will run under (in this UI's view):
  //   user override `runtime` (if set) > Agent's runtime > 'builtin' default
  // External runtimes self-manage model/permission/MCP, so all three
  // sub-fields are gated on `effectiveRuntime === 'builtin'`.
  const agentRuntime: RuntimeType = workspaceAgent?.runtime ?? 'builtin';
  const effectiveRuntime: RuntimeType = multiAgentRuntimeEnabled
    ? (runtime ?? agentRuntime)
    : 'builtin';
  const isBuiltin = effectiveRuntime === 'builtin';
  const agentRuntimeLabel = RUNTIME_DISPLAY_NAMES[agentRuntime] ?? agentRuntime;
  const effectiveRuntimeLabel = RUNTIME_DISPLAY_NAMES[effectiveRuntime] ?? effectiveRuntime;

  // Wrap `setRuntime` to clear runtime-specific stale fields on switch:
  //   - Model / MCP only apply to the builtin SDK (external runtimes
  //     self-manage), so we drop those when switching off builtin.
  //   - PermissionMode strings are runtime-specific (builtin uses
  //     `auto`/`plan`/`fullAgency`; CC uses `default`/`acceptEdits`/…;
  //     Codex uses `suggest`/`auto-edit`/…). Carrying a permissionMode
  //     across a runtime switch leaves a value the new runtime can't
  //     interpret — clear so the user reselects from the right list.
  // Compares the NEW effective runtime to the OLD one so a no-op toggle
  // (override → "follow Agent" but Agent is the same kind) doesn't
  // gratuitously clear good values.
  const setRuntime = useCallback(
    (next: RuntimeType | undefined) => {
      setRuntimeRaw(next);
      const nextEffective: RuntimeType = next ?? agentRuntime;
      if (nextEffective !== effectiveRuntime) {
        if (permissionMode !== undefined) setPermissionMode(undefined);
      }
      if (nextEffective !== 'builtin') {
        if (model !== undefined) setModel(undefined);
        if (mcpEnabledServers !== undefined) setMcpEnabledServers(undefined);
      }
    },
    [
      setRuntimeRaw,
      setModel,
      setPermissionMode,
      setMcpEnabledServers,
      model,
      permissionMode,
      mcpEnabledServers,
      agentRuntime,
      effectiveRuntime,
    ],
  );

  // Workspace project — used to resolve provider/model fallback when the
  // Agent's `model` is unset, and to derive the display name for hint copy.
  const workspaceProject = useMemo(() => {
    if (!workspacePath) return null;
    return projects.find((p) => p.path === workspacePath) ?? null;
  }, [workspacePath, projects]);

  // Workspace display label — derived locally from the resolved project so
  // the parent dialog doesn't have to thread a separate `workspaceLabel`
  // prop. Mirrors the precedence used elsewhere (Launcher / DispatchTaskDialog).
  const workspaceDisplayName =
    workspaceProject?.displayName
    || workspaceProject?.name
    || '';

  // Resolve the workspace's provider — mirrors WorkspaceBasicsSection's
  // precedence exactly so the "current model" hint here matches the model
  // shown in Agent settings (PRD 0.2.4 cross-review user feedback):
  //   agent.providerId → project.providerId → null
  //
  // We deliberately DO NOT fall back to `config.defaultProviderId` for
  // display — that would surface a model the user never picked for this
  // workspace. For legacy projects with no provider at all, the picker
  // shows the "未配置 provider" empty state instead of a misleading
  // global default.
  const workspaceProvider = useMemo(() => {
    const providerId =
      workspaceAgent?.providerId
      ?? workspaceProject?.providerId
      ?? null;
    if (!providerId) return null;
    return providers.find((p) => p.id === providerId) ?? null;
  }, [workspaceAgent, workspaceProject, providers]);

  // "Current model" display — same precedence + display rule as
  // WorkspaceBasicsSection so the hint here reads identically to Agent
  // settings (e.g. "Kimi K2.6", not the raw model id "moonshotai/Kimi-K2.6"):
  //   1. effectiveModel = agent.model ?? project.model
  //   2. modelName: if effectiveModel is in provider.models → modelName;
  //                 else effectiveModel itself; else provider.primaryModel.
  const workspaceEffectiveModelId =
    workspaceAgent?.model || workspaceProject?.model || '';
  const workspaceDefaultModelLabel = (() => {
    if (workspaceEffectiveModelId) {
      const hit = workspaceProvider?.models?.find(
        (m) => m.model === workspaceEffectiveModelId,
      );
      return hit?.modelName || workspaceEffectiveModelId;
    }
    return workspaceProvider?.primaryModel || '';
  })();

  const modelOptions = useMemo(() => {
    if (!workspaceProvider) return [{ value: FOLLOW_VALUE, label: '跟随 Agent 工作区' }];
    const opts = [
      {
        value: FOLLOW_VALUE,
        label: workspaceDefaultModelLabel
          ? `跟随 Agent（当前 ${workspaceDefaultModelLabel}）`
          : '跟随 Agent 工作区',
      },
      ...workspaceProvider.models.map((m) => ({
        value: m.model,
        label: m.modelName ? `${m.modelName} · ${m.model}` : m.model,
      })),
    ];
    // Surface a previously-set model that isn't in the catalogue (legacy /
    // hand-typed) so the user can see and clear it without it silently
    // appearing as "跟随 Agent" in the dropdown.
    if (model && !workspaceProvider.models.some((m) => m.model === model)) {
      opts.push({ value: model, label: `其他：${model}` });
    }
    return opts;
  }, [workspaceProvider, workspaceDefaultModelLabel, model]);

  // MCP catalogue — single source of truth via the shared
  // `getAllMcpServersFromConfig` helper (preset + custom merge, platform
  // filter, args/env overrides). Without this, the editor used to
  // duplicate the preset+custom merge inline and silently dropped the
  // args/env override layer that production execution actually applies —
  // the picker would visually claim a server "is enabled" while the
  // running cron tick used a different env. PRD 0.2.4 §3.6.
  const mcpCatalogue: McpServerDefinition[] = useMemo(() => {
    if (!config) return [];
    return getAllMcpServersFromConfig(config).slice().sort(
      (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'),
    );
  }, [config]);

  const runtimeOptions = useMemo(
    () => [
      {
        value: FOLLOW_VALUE,
        // Inline the Agent's actual current runtime in the option label
        // (consistent with the model picker's "跟随 Agent（当前 X）" shape)
        // so the user can see what "follow" resolves to without scanning a
        // separate hint line. `agentRuntimeLabel` is always truthy because
        // the fallback chain (`RUNTIME_DISPLAY_NAMES[r] ?? r`) covers every
        // possible RuntimeType.
        label: `跟随 Agent 工作区（当前 ${agentRuntimeLabel}）`,
      },
      ...VALID_RUNTIMES.map((r) => ({
        value: r,
        label: RUNTIME_DISPLAY_NAMES[r],
      })),
    ],
    [agentRuntimeLabel],
  );

  // Permission-mode options — runtime-specific. Each runtime defines its
  // own set of permission strings (builtin: auto/plan/fullAgency/custom;
  // CC: default/acceptEdits/bypassPermissions/plan/dontAsk/auto;
  // Codex: suggest/auto-edit/full-auto/no-restrictions; Gemini:
  // default/autoEdit/yolo/plan). Sourcing from the canonical
  // `getRuntimePermissionModes` registry means adding a new runtime's
  // perm modes only requires updating that one switch — the picker here
  // surfaces them automatically.
  const permissionOptions = useMemo(
    () => [
      { value: FOLLOW_VALUE, label: '跟随默认（最大权限）' },
      ...getRuntimePermissionModes(effectiveRuntime).map((m) => ({
        value: m.value,
        label: m.description ? `${m.label} · ${m.description}` : m.label,
      })),
    ],
    [effectiveRuntime],
  );

  // Toggle a single MCP server in the override list (PRD 0.2.4 §需求 4).
  //
  // Two-state model — "follow Agent" (`undefined`) vs. "override with this
  // explicit list" (`[a, b, ...]`). Dropping the last item collapses back
  // to `undefined` so an emptied list never lingers as a meaningless
  // "explicit empty" — Rust's `update` treats `Some(vec![])` as a clear
  // anyway, so collapsing here keeps the wire/storage shapes 1:1.
  const toggleMcp = (id: string) => {
    if (mcpEnabledServers === undefined) {
      setMcpEnabledServers([id]);
      return;
    }
    if (mcpEnabledServers.includes(id)) {
      const next = mcpEnabledServers.filter((s) => s !== id);
      // Last item dropped → revert to "follow Agent" rather than
      // persisting `[]` (which the backend coerces to follow anyway).
      setMcpEnabledServers(next.length === 0 ? undefined : next);
    } else {
      setMcpEnabledServers([...mcpEnabledServers, id]);
    }
  };

  const resetMcpToFollow = () => setMcpEnabledServers(undefined);

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--line)]">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded-[var(--radius-md)] px-4 py-2.5 text-left transition-colors hover:bg-[var(--hover-bg)]"
        aria-expanded={open}
      >
        <Settings2 className="h-4 w-4 text-[var(--ink-muted)]" strokeWidth={1.5} />
        <span className="flex-1 text-[13px] font-medium text-[var(--ink)]">
          高级配置
          <span className="ml-1.5 text-[12px] font-normal text-[var(--ink-muted)]">
            （可选 — 覆盖本次任务的 runtime / 模型 / 权限 / MCP）
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--ink-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="space-y-5 border-t border-[var(--line-subtle)] px-4 py-4">
          {/* Runtime — visible only when the multi-agent-runtime gate is on.
              When off, the rest of the editor still renders normally; effective
              runtime is forced to 'builtin' upstream so model/permission/MCP
              fields show their builtin variant. Mirrors WorkspaceBasicsSection's
              gate treatment so the two surfaces feel consistent. */}
          {multiAgentRuntimeEnabled && (
            <FieldRow
              label="Runtime"
              hint={
                workspaceDisplayName
                  ? `不选择时跟随 ${workspaceDisplayName}`
                  : '不选择时跟随 Agent 工作区'
              }
            >
              <CustomSelect
                value={runtime ?? FOLLOW_VALUE}
                options={runtimeOptions}
                onChange={(v) => setRuntime(v ? (v as RuntimeType) : undefined)}
                placeholder="跟随 Agent 工作区"
              />
            </FieldRow>
          )}

          {/* External runtime notice — when the effective runtime is not
              builtin, the Model / Permission / MCP sub-fields are hidden
              because external runtimes (Claude Code CLI / Codex / Gemini)
              manage those concerns through their own CLI flags. Mirrors
              the WorkspaceBasicsSection treatment of the same situation
              so the two surfaces feel consistent. */}
          {!isBuiltin && (
            <p className="rounded-[var(--radius-md)] bg-[var(--accent-warm-subtle)] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--ink-muted)]">
              当前任务的运行环境为
              <span className="mx-1 font-medium text-[var(--ink-secondary)]">{effectiveRuntimeLabel}</span>
              ，模型 / MCP 工具由 {effectiveRuntimeLabel} 自身管理。下方权限模式为该 runtime 的可选项，可单独覆盖。
            </p>
          )}

          {/* Permission mode — visible for EVERY runtime. The option list
              pivots on the effective runtime via getRuntimePermissionModes
              (builtin: auto/plan/fullAgency/custom; CC: default/acceptEdits/…;
              Codex: suggest/auto-edit/…; Gemini: default/autoEdit/yolo/plan).
              "跟随默认（最大权限）" sentinel means: at execution time, fall
              back to the runtime's max permission (cron is unattended). */}
          <FieldRow
            label="权限模式"
            hint="不选择时使用所选 runtime 的最大权限（无人值守任务默认）；选择后强制使用该模式"
          >
            <CustomSelect
              value={permissionMode ?? FOLLOW_VALUE}
              options={permissionOptions}
              onChange={(v) => setPermissionMode(v ? v : undefined)}
              placeholder="跟随默认（最大权限）"
            />
          </FieldRow>

          {/* Model — only meaningful when builtin runtime is effective.
              External runtimes resolve their own model from the runtime
              process; the picker pulls models from the workspace's
              provider (cross-provider override is out of scope for v0.2.4). */}
          {isBuiltin && (
            <FieldRow
              label="模型"
              hint="不选择时跟随 Agent 当前模型；选择后强制使用该模型"
            >
              {workspaceProvider ? (
                <CustomSelect
                  value={model ?? FOLLOW_VALUE}
                  options={modelOptions}
                  onChange={(v) => setModel(v ? v : undefined)}
                  placeholder="跟随 Agent 工作区"
                />
              ) : (
                <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] px-3 py-2 text-[12px] text-[var(--ink-muted)]">
                  工作区未配置 provider — 请先在工作区设置中选择一个 provider 才能在此覆盖模型
                </div>
              )}
            </FieldRow>
          )}

          {/* MCP enable list — builtin only. Hint + reset action share a
              single bottom row: status text on the left, "恢复跟随 Agent"
              on the right (only when there's actually an override to revert
              — pristine state hides the button rather than disabling it,
              since a disabled button reads as "I should be able to click
              this but can't" while no button reads as "nothing to do here"). */}
          {isBuiltin && (
            <FieldRow label="MCP 工具">
              {mcpCatalogue.length === 0 ? (
                <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--line)] px-3 py-3 text-[12px] text-[var(--ink-muted)]">
                  尚未在「设置 → MCP 工具」中安装任何 MCP，无法在此覆盖。
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    {mcpCatalogue.map((s) => {
                      const checked = mcpEnabledServers
                        ? mcpEnabledServers.includes(s.id)
                        : false; // pristine = visually unchecked, label says "跟随"
                      return (
                        <label
                          key={s.id}
                          className={`flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] border border-transparent px-2 py-1 text-[12px] text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] ${
                            checked
                              ? 'border-[var(--accent-warm)]/30 bg-[var(--accent-warm-subtle)] text-[var(--ink)]'
                              : ''
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleMcp(s.id)}
                            className="h-3.5 w-3.5 accent-[var(--accent-warm)]"
                          />
                          <span className="truncate">{s.name}</span>
                        </label>
                      );
                    })}
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-3 text-[12px] leading-snug text-[var(--ink-muted)]">
                    <span>
                      {mcpEnabledServers === undefined
                        ? '当前跟随 Agent 工作区的 MCP 启用列表'
                        : `当前启用 ${mcpEnabledServers.length} 个 MCP 工具`}
                    </span>
                    {mcpEnabledServers !== undefined && (
                      <button
                        type="button"
                        onClick={resetMcpToFollow}
                        className="shrink-0 text-[var(--ink-muted)] transition-colors hover:text-[var(--accent-warm)]"
                      >
                        恢复跟随 Agent
                      </button>
                    )}
                  </div>
                </>
              )}
            </FieldRow>
          )}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[13px] font-medium text-[var(--ink-secondary)]">
          {label}
        </span>
      </div>
      {children}
      {hint && (
        <p className="mt-1.5 text-[12px] leading-snug text-[var(--ink-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}

export default TaskAdvancedConfigEditor;
