// TaskEditPanel — edit mode for a Task. Rendered inside `TaskDetailOverlay`
// when the user clicks the 「编辑」 affordance. Shares its scheduling and
// end-condition editors with the dispatch dialog so creation and subsequent
// edits stay pixel-aligned.
//
// All field mutations flow into a local `draft` state; the save handler diffs
// against the initial Task and sends only the changed fields through
// `cmd_task_update` (PRD §9.4 — schedule-shape changes also detach the
// backing CronTask, handled in Rust). Cancel discards the draft and rolls
// back to read-only view.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';

import {
  taskOpenDocsDir,
  taskReadDoc,
  taskUpdate,
  taskWriteDoc,
} from '@/api/taskCenter';
import NotificationConfigEditor from '@/components/task-center/NotificationConfigEditor';
import { useToast } from '@/components/Toast';
import type {
  EndConditions,
  NotificationConfig,
  Task,
  TaskExecutionMode,
  TaskRunMode,
  TaskUpdateInput,
} from '@/../shared/types/task';
import {
  EndConditionsEditor,
  type EndConditionMode,
} from './editors/EndConditionsEditor';
import { ExecutionModeEditor } from './editors/ExecutionModeEditor';
import { INPUT_CLS, toLocalDateTimeString } from './editors/controls';
import { TaskAdvancedConfigEditor } from './editors/TaskAdvancedConfigEditor';
import type { RuntimeType } from '@/../shared/types/runtime';
import { extractErrorMessage } from './errors';

/** Which section/field the edit panel should scroll to + focus on open.
 *  Exported so callers (e.g. TaskDetailOverlay's inline "编辑" buttons)
 *  can pass a specific target without magic strings. `null` / undefined
 *  = open at the top (basic-info section).
 */
export type FocusDoc = 'task' | 'verify' | 'notification';

export interface TaskEditPanelProps {
  task: Task;
  /** If set, the panel scroll-focuses this section on mount. */
  focusDoc?: FocusDoc | null;
  onSaved: (next: Task) => void;
  onCancel: () => void;
  onError: (msg: string) => void;
}

interface Draft {
  name: string;
  description: string;
  tagsInput: string;
  taskMd: string;
  verifyMd: string;
  executionMode: TaskExecutionMode;
  runMode: TaskRunMode;
  atDateTime: string;
  intervalMinutes: number;
  cronExpression: string;
  cronTimezone: string;
  endConditionMode: EndConditionMode;
  deadline: string;
  maxExecutions: string;
  aiCanExit: boolean;
  notification: NotificationConfig;
  // Advanced overrides — `undefined` means "follow Agent". (PRD 0.2.4 §需求 4)
  runtime: RuntimeType | undefined;
  model: string | undefined;
  permissionMode: string | undefined;
  mcpEnabledServers: string[] | undefined;
}

function taskToDraft(task: Task, taskMd: string): Draft {
  // End-condition mode is derived: if any constraint is present, the user
  // intended "conditional"; otherwise "forever".
  const ec = task.endConditions;
  const hasConstraints = !!(ec?.deadline || ec?.maxExecutions);
  const endConditionMode: EndConditionMode = hasConstraints ? 'conditional' : 'forever';
  // `dispatchAt` is now the authoritative "when to fire" timestamp for
  // scheduled mode. Fall back to the legacy `endConditions.deadline` for
  // rows created before the split.
  const atSource = task.dispatchAt ?? (task.executionMode === 'scheduled' ? ec?.deadline : undefined);
  const atDateTime = atSource ? toLocalDateTimeString(new Date(atSource)) : '';
  return {
    name: task.name,
    description: task.description ?? '',
    tagsInput: task.tags.join(', '),
    taskMd,
    verifyMd: '',
    executionMode: task.executionMode,
    runMode: task.runMode ?? 'new-session',
    atDateTime,
    intervalMinutes: task.intervalMinutes ?? 30,
    cronExpression: task.cronExpression ?? '',
    cronTimezone: task.cronTimezone ?? '',
    endConditionMode,
    deadline: ec?.deadline ? toLocalDateTimeString(new Date(ec.deadline)) : '',
    maxExecutions: ec?.maxExecutions ? String(ec.maxExecutions) : '',
    aiCanExit: ec?.aiCanExit ?? true,
    notification: task.notification ?? { desktop: true },
    runtime: task.runtime,
    // Empty string from disk = "no override"; surface as undefined so the
    // advanced editor's "跟随 Agent" sentinel is respected.
    model: task.model && task.model.length > 0 ? task.model : undefined,
    permissionMode:
      task.permissionMode && task.permissionMode.length > 0
        ? task.permissionMode
        : undefined,
    mcpEnabledServers: task.mcpEnabledServers,
  };
}

export function TaskEditPanel({
  task,
  focusDoc = null,
  onSaved,
  onCancel,
  onError,
}: TaskEditPanelProps) {
  const [draft, setDraft] = useState<Draft>(() => taskToDraft(task, ''));
  const [saving, setSaving] = useState(false);
  // Tri-state: null (loading) | true (loaded) | false (failed) — separate
  // from just "loaded" so a read failure doesn't silently let the user
  // overwrite their existing task.md with an empty string (C2 review).
  const [taskMdReadState, setTaskMdReadState] =
    useState<'loading' | 'ok' | 'failed'>('loading');
  // verify.md reads are allowed to return "" (verify is optional); we only
  // track ok/failed so a failed read doesn't let the user save an empty
  // body that would wipe an existing file (PRD §9.4).
  const [verifyMdReadState, setVerifyMdReadState] =
    useState<'loading' | 'ok' | 'failed'>('loading');
  // The initial verify.md body (as loaded from disk) — kept in a ref so
  // `handleSave` can diff against it without re-triggering when only
  // `draft.verifyMd` changes. Updated after a successful write so a
  // second save only persists further edits.
  const verifyMdInitialRef = useRef('');
  const isAiAligned = task.dispatchOrigin === 'ai-aligned';
  const toast = useToast();

  // Refs for `focusDoc` — scroll-into-view + caret focus on open. Effect
  // runs on mount only (focusDoc is an intent, not a live mode). For
  // task.md / verify.md we also select so the user can start typing
  // immediately to replace content; for notification we only scroll.
  const taskMdRef = useRef<HTMLTextAreaElement | null>(null);
  const verifyMdRef = useRef<HTMLTextAreaElement | null>(null);
  const notificationRef = useRef<HTMLDivElement | null>(null);
  // Fire-once latch: once we've scrolled + focused for a given focusDoc
  // value, don't fire again if read-state re-renders push the effect.
  const focusAppliedRef = useRef<FocusDoc | null>(null);
  useEffect(() => {
    if (!focusDoc) {
      focusAppliedRef.current = null;
      return;
    }
    if (focusAppliedRef.current === focusDoc) return;
    // Gate on the relevant doc being loaded — focusing a disabled
    // textarea is a no-op, so firing too early (before the filesystem
    // read lands) silently misses. Previously this was a hard-coded
    // 80ms timeout, which is both flaky on slow disks and a magic
    // number. Now we wait until the textarea is enabled.
    if (focusDoc === 'task' && taskMdReadState === 'loading') return;
    if (focusDoc === 'verify' && verifyMdReadState === 'loading') return;
    // Defer to next frame so the refs are wired and layout is settled.
    const raf = requestAnimationFrame(() => {
      const el =
        focusDoc === 'task' ? taskMdRef.current
          : focusDoc === 'verify' ? verifyMdRef.current
            : focusDoc === 'notification' ? notificationRef.current
              : null;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (el instanceof HTMLTextAreaElement) {
        el.focus({ preventScroll: true });
      }
      focusAppliedRef.current = focusDoc;
    });
    return () => cancelAnimationFrame(raf);
  }, [focusDoc, taskMdReadState, verifyMdReadState]);

  // Read the current task.md + verify.md bodies once so the user can
  // edit both in-place. AI-aligned tasks have no editable prompt here
  // (their alignment.md is the source of truth and a separate skill) —
  // but they can still author verify.md for the verification step.
  useEffect(() => {
    let cancelled = false;
    if (isAiAligned) {
      setTaskMdReadState('ok');
    } else {
      void taskReadDoc(task.id, 'task')
        .then((content) => {
          if (cancelled) return;
          setDraft((d) => ({ ...d, taskMd: content }));
          setTaskMdReadState('ok');
        })
        .catch(() => {
          if (cancelled) return;
          setTaskMdReadState('failed');
        });
    }
    void taskReadDoc(task.id, 'verify')
      .then((content) => {
        if (cancelled) return;
        setDraft((d) => ({ ...d, verifyMd: content }));
        verifyMdInitialRef.current = content;
        setVerifyMdReadState('ok');
      })
      .catch(() => {
        if (cancelled) return;
        setVerifyMdReadState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, isAiAligned]);

  const handleOpenDocsDir = useCallback(async () => {
    try {
      await taskOpenDocsDir(task.id);
    } catch (e) {
      toast.error(extractErrorMessage(e));
    }
  }, [task.id, toast]);

  // If the task transitions to running / verifying while we're editing
  // (external SSE — scheduler fired, or another window changed status),
  // we'd be presenting editable controls the backend will reject. Bail
  // out of edit mode and surface why.
  const locked = task.status === 'running' || task.status === 'verifying';
  useEffect(() => {
    if (locked) {
      onError('任务已开始执行，编辑已取消（PRD §9.4）。');
      onCancel();
    }
  }, [locked, onCancel, onError]);

  const isScheduled = draft.executionMode === 'scheduled';
  const isRecurring = draft.executionMode === 'recurring';
  const isLoop = draft.executionMode === 'loop';
  const showEndConditions = isRecurring || isLoop;

  // Keep runMode aligned with PRD §9.2 defaults when user flips mode.
  const setExecutionMode = useCallback((next: TaskExecutionMode) => {
    setDraft((d) => {
      const nextRunMode: TaskRunMode =
        next === 'loop' ? 'single-session'
          : next === 'recurring' ? 'new-session'
            : d.runMode;
      return { ...d, executionMode: next, runMode: nextRunMode };
    });
  }, []);

  const errors = useMemo(() => {
    const errs: string[] = [];
    if (!draft.name.trim()) errs.push('请填写任务名');
    if (!isAiAligned && taskMdReadState === 'failed')
      errs.push('task.md 读取失败，无法保存（以免覆盖原内容）');
    if (!isAiAligned && taskMdReadState === 'ok' && !draft.taskMd.trim())
      errs.push('task.md 内容不能为空');
    if (verifyMdReadState === 'failed')
      errs.push('verify.md 读取失败，无法保存（以免覆盖原内容）');
    if (isScheduled) {
      const ts = Date.parse(draft.atDateTime);
      if (Number.isNaN(ts) || ts <= Date.now()) errs.push('执行时间必须在未来');
    }
    if (isRecurring) {
      const advancedOn = draft.cronExpression.trim().length > 0;
      if (advancedOn) {
        // Rust nom-cron is strict; do a shallow shape check here to catch
        // the obvious "forgot a field" mistake before the backend would.
        if (draft.cronExpression.trim().split(/\s+/).length !== 5) {
          errs.push('Cron 表达式必须是 5 段(分 时 日 月 周)');
        }
      } else if (draft.intervalMinutes < 5) {
        errs.push('周期间隔不能小于 5 分钟');
      }
    }
    if (
      showEndConditions &&
      draft.endConditionMode === 'conditional' &&
      !draft.deadline &&
      !draft.maxExecutions &&
      !draft.aiCanExit
    ) {
      errs.push('请至少设置一个结束条件');
    }
    return errs;
  }, [draft, isScheduled, isRecurring, showEndConditions, isAiAligned, taskMdReadState, verifyMdReadState]);

  const buildEndConditions = useCallback((): EndConditions | undefined => {
    if (!showEndConditions) return undefined;
    if (draft.endConditionMode === 'forever') return { aiCanExit: draft.aiCanExit };
    const out: EndConditions = { aiCanExit: draft.aiCanExit };
    if (draft.deadline) {
      const ts = Date.parse(draft.deadline);
      if (!Number.isNaN(ts)) out.deadline = ts;
    }
    if (draft.maxExecutions) {
      const n = parseInt(draft.maxExecutions, 10);
      if (!Number.isNaN(n) && n > 0) out.maxExecutions = n;
    }
    return out;
  }, [draft, showEndConditions]);

  const handleSave = useCallback(async () => {
    if (errors.length > 0 || saving) return;
    const tags = draft.tagsInput
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    // Build a partial update. `Option<T>` on the Rust side means "don't
    // touch this field" for any key we omit — so we send only what the
    // user actually changed. Rust's `update()` takes care of clearing
    // mode-incompatible fields when `executionMode` flips (PRD §9.4
    // hygiene), so we just forward the draft.
    const payload: TaskUpdateInput = { id: task.id };
    if (draft.name.trim() !== task.name) payload.name = draft.name.trim();
    if (draft.description.trim() !== (task.description ?? ''))
      payload.description = draft.description.trim();
    const initialTags = task.tags.join(',');
    if (tags.join(',') !== initialTags) payload.tags = tags;

    if (!isAiAligned && taskMdReadState === 'ok') {
      // Only persist when we actually loaded the current body — a failed
      // read must not let the user overwrite with whatever's in the
      // textarea (could be the empty default).
      payload.prompt = draft.taskMd;
    }

    const modeChanged = draft.executionMode !== task.executionMode;
    if (modeChanged) payload.executionMode = draft.executionMode;

    if (draft.executionMode !== 'once') {
      const nextRunMode: TaskRunMode = isLoop ? 'single-session' : draft.runMode;
      if (modeChanged || nextRunMode !== task.runMode) payload.runMode = nextRunMode;

      const ec = buildEndConditions();
      const initialEc = JSON.stringify(task.endConditions ?? null);
      const nextEc = JSON.stringify(ec ?? null);
      if (modeChanged || initialEc !== nextEc) payload.endConditions = ec;
    }

    // Scheduling detail — only forward the field relevant to the target
    // mode so the Rust layer's mode-hygiene cleanup can do its job.
    if (isScheduled) {
      const ts = Date.parse(draft.atDateTime);
      if (!Number.isNaN(ts) && ts !== task.dispatchAt) {
        payload.dispatchAt = ts;
      }
    } else if (isRecurring) {
      const advanced = draft.cronExpression.trim();
      if (advanced) {
        if (advanced !== (task.cronExpression ?? '')) payload.cronExpression = advanced;
        if (draft.cronTimezone !== (task.cronTimezone ?? ''))
          payload.cronTimezone = draft.cronTimezone;
      } else {
        // Simple mode — clear any cron expression the task had before.
        if (task.cronExpression) payload.cronExpression = '';
        if (task.cronTimezone) payload.cronTimezone = '';
        if (draft.intervalMinutes !== (task.intervalMinutes ?? 0)) {
          payload.intervalMinutes = draft.intervalMinutes;
        }
      }
    }

    // Execution overrides — diff against the persisted Task. Sending an
    // empty string clears (Rust `update()` treats `Some("")` as
    // `permission_mode = None`); sending undefined leaves the field untouched.
    const draftModel = draft.model ?? '';
    if (draftModel !== (task.model ?? '')) payload.model = draftModel;
    const draftPermissionMode = draft.permissionMode ?? '';
    if (draftPermissionMode !== (task.permissionMode ?? '')) {
      payload.permissionMode = draftPermissionMode;
    }
    if ((draft.runtime ?? '') !== (task.runtime ?? '')) {
      payload.runtime = draft.runtime;
    }
    // mcpEnabledServers diff. Send an actual array when there's a change;
    // mapping "follow Agent" (draft = undefined) → `[]` since Rust's
    // `update()` treats an empty vec as "clear override". A real tri-state
    // for "explicitly run with no MCP" is out of scope for v0.2.4.
    const initialMcp = JSON.stringify(task.mcpEnabledServers ?? []);
    const draftMcp = JSON.stringify(draft.mcpEnabledServers ?? []);
    if (initialMcp !== draftMcp) {
      payload.mcpEnabledServers = draft.mcpEnabledServers ?? [];
    }

    const initialNotification = JSON.stringify(task.notification ?? null);
    const nextNotification = JSON.stringify(draft.notification);
    if (initialNotification !== nextNotification)
      payload.notification = draft.notification;

    // verify.md is NOT part of the Task row update — it's a separate
    // `write_doc` call. Compute change here so we know whether to
    // short-circuit "no changes" AND whether to spend a second IPC call.
    // `verifyMdInitial` is what we loaded from disk; draft starts equal,
    // so a plain string comparison catches edits.
    const verifyChanged =
      verifyMdReadState === 'ok' && draft.verifyMd !== verifyMdInitialRef.current;

    // Bail if nothing changed — stay in edit mode so the user isn't
    // thrown back to read-only with no feedback.
    if (Object.keys(payload).length === 1 && !verifyChanged) {
      onError('没有需要保存的变更');
      return;
    }

    setSaving(true);
    try {
      // verify.md first: the TaskStore::update path re-reads the row and
      // may bump `updated_at`, but verify.md writes go through a separate
      // atomic write. Writing verify.md first means a mid-flight failure
      // leaves metadata untouched (easier to reason about).
      if (verifyChanged) {
        await taskWriteDoc(task.id, 'verify', draft.verifyMd);
        verifyMdInitialRef.current = draft.verifyMd;
      }
      // If only verify.md changed, skip the Task row update (payload
      // would have only `id` in it and the Rust-side `update()` bumps
      // `updated_at` even with an empty diff).
      if (Object.keys(payload).length > 1) {
        const updated = await taskUpdate(payload);
        onSaved(updated);
      } else {
        // verify.md-only edit: refetch the task so `onSaved` hands back
        // a row with a fresh `updated_at`. `taskWriteDoc` already bumped
        // it on the backend.
        onSaved({ ...task, updatedAt: Date.now() });
      }
    } catch (e) {
      onError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [
    draft,
    errors,
    saving,
    task,
    buildEndConditions,
    isScheduled,
    isRecurring,
    isLoop,
    isAiAligned,
    taskMdReadState,
    verifyMdReadState,
    onSaved,
    onError,
  ]);

  return (
    <div className="space-y-5">
      {/* 基本信息 */}
      <section>
        <h3 className="mb-3 text-[14px] font-semibold text-[var(--ink)]">
          基本信息
        </h3>
        <div className="space-y-3 pl-1">
          <Field label="任务名称" required>
            <input
              type="text"
              value={draft.name}
              maxLength={120}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              className={INPUT_CLS}
            />
          </Field>
          <Field label="简短描述" hint="可选">
            <input
              type="text"
              value={draft.description}
              maxLength={200}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              placeholder="一行话说明，任务卡会展示"
              className={INPUT_CLS}
            />
          </Field>
          <Field label="标签" hint="逗号分隔">
            <input
              type="text"
              value={draft.tagsInput}
              onChange={(e) => setDraft((d) => ({ ...d, tagsInput: e.target.value }))}
              placeholder="例如: news, weekly"
              className={INPUT_CLS}
            />
          </Field>
        </div>
      </section>

      {!isAiAligned && (
        <>
          <div className="border-t border-[var(--line-subtle)]" />
          <section>
            <DocSectionHeader
              title="task.md 内容"
              path={`~/.myagents/tasks/${task.id}/task.md`}
              onOpenFolder={handleOpenDocsDir}
            />
            <div className="pl-1">
              {taskMdReadState === 'failed' ? (
                <div className="rounded-[var(--radius-md)] border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2.5 text-[12px] text-[var(--error)]">
                  task.md 读取失败。为避免覆盖原内容，编辑已锁定。请关闭重试，或检查磁盘权限后再打开此任务。
                </div>
              ) : (
                <>
                  <textarea
                    ref={taskMdRef}
                    value={draft.taskMd}
                    onChange={(e) => setDraft((d) => ({ ...d, taskMd: e.target.value }))}
                    rows={8}
                    disabled={taskMdReadState !== 'ok'}
                    placeholder={
                      taskMdReadState === 'ok'
                        ? '描述任务目标、约束、上下文'
                        : '加载中…'
                    }
                    className={`${INPUT_CLS} resize-y font-mono text-[13px]`}
                  />
                  <p className="mt-2 text-[12px] text-[var(--ink-muted)]">
                    AI 执行时看到的 prompt。保存时会原子写入上方路径。
                  </p>
                </>
              )}
            </div>
          </section>
        </>
      )}

      {/* verify.md — optional checklist the agent reads when the task
          enters the "verify" phase. Editable here regardless of
          dispatchOrigin (AI-aligned tasks still need a verification
          script even though their task.md is synthesized from
          alignment.md). */}
      <div className="border-t border-[var(--line-subtle)]" />
      <section>
        <DocSectionHeader
          title="verify.md 内容"
          hint="可选"
          path={`~/.myagents/tasks/${task.id}/verify.md`}
          onOpenFolder={handleOpenDocsDir}
        />
        <div className="pl-1">
          {verifyMdReadState === 'failed' ? (
            <div className="rounded-[var(--radius-md)] border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2.5 text-[12px] text-[var(--error)]">
              verify.md 读取失败。为避免覆盖原内容，编辑已锁定。
            </div>
          ) : (
            <>
              <textarea
                ref={verifyMdRef}
                value={draft.verifyMd}
                onChange={(e) => setDraft((d) => ({ ...d, verifyMd: e.target.value }))}
                rows={6}
                disabled={verifyMdReadState !== 'ok'}
                placeholder={
                  verifyMdReadState === 'ok'
                    ? '验收清单(可选)——如:「curl /health 应返回 200」「npm test 全绿」'
                    : '加载中…'
                }
                className={`${INPUT_CLS} resize-y font-mono text-[13px]`}
              />
              <p className="mt-2 text-[12px] text-[var(--ink-muted)]">
                任务进入「验证中」阶段时 AI 读取此清单判定是否完成。留空则跳过验证阶段。
              </p>
            </>
          )}
        </div>
      </section>

      <div className="border-t border-[var(--line-subtle)]" />

      {/* 高级配置 — runtime / model / permission / MCP overrides */}
      <section>
        <div className="pl-1">
          <TaskAdvancedConfigEditor
            workspaceLabel={workspaceDisplayName(task)}
            runtime={draft.runtime}
            setRuntime={(v) => setDraft((d) => ({ ...d, runtime: v }))}
            model={draft.model}
            setModel={(v) => setDraft((d) => ({ ...d, model: v }))}
            permissionMode={draft.permissionMode}
            setPermissionMode={(v) => setDraft((d) => ({ ...d, permissionMode: v }))}
            mcpEnabledServers={draft.mcpEnabledServers}
            setMcpEnabledServers={(v) =>
              setDraft((d) => ({ ...d, mcpEnabledServers: v }))
            }
          />
        </div>
      </section>

      <div className="border-t border-[var(--line-subtle)]" />

      {/* 执行模式 */}
      <section>
        <h3 className="mb-3 text-[14px] font-semibold text-[var(--ink)]">
          执行模式
        </h3>
        <div className="pl-1">
          <ExecutionModeEditor
            executionMode={draft.executionMode}
            setExecutionMode={setExecutionMode}
            runMode={draft.runMode}
            setRunMode={(v) => setDraft((d) => ({ ...d, runMode: v }))}
            atDateTime={draft.atDateTime}
            setAtDateTime={(v) => setDraft((d) => ({ ...d, atDateTime: v }))}
            intervalMinutes={draft.intervalMinutes}
            setIntervalMinutes={(v) => setDraft((d) => ({ ...d, intervalMinutes: v }))}
            cronExpression={draft.cronExpression}
            setCronExpression={(v) => setDraft((d) => ({ ...d, cronExpression: v }))}
            cronTimezone={draft.cronTimezone}
            setCronTimezone={(v) => setDraft((d) => ({ ...d, cronTimezone: v }))}
          />
        </div>
      </section>

      {showEndConditions && (
        <>
          <div className="border-t border-[var(--line-subtle)]" />
          <section>
            <h3 className="mb-3 text-[14px] font-semibold text-[var(--ink)]">
              结束条件
            </h3>
            <div className="pl-1">
              <EndConditionsEditor
                mode={draft.endConditionMode}
                setMode={(v) => setDraft((d) => ({ ...d, endConditionMode: v }))}
                deadline={draft.deadline}
                setDeadline={(v) => setDraft((d) => ({ ...d, deadline: v }))}
                maxExecutions={draft.maxExecutions}
                setMaxExecutions={(v) => setDraft((d) => ({ ...d, maxExecutions: v }))}
                aiCanExit={draft.aiCanExit}
                setAiCanExit={(v) => setDraft((d) => ({ ...d, aiCanExit: v }))}
              />
            </div>
          </section>
        </>
      )}

      <div className="border-t border-[var(--line-subtle)]" />

      {/* v0.2.4: model / permissionMode / runtime / mcpEnabledServers
          overrides moved into the dedicated 「高级配置」 section above.
          The scheduler still reads them from Task.* (ensure_cron_for_task)
          so existing tasks keep working. */}

      {/* 通知 */}
      <section ref={notificationRef}>
        <h3 className="mb-3 text-[14px] font-semibold text-[var(--ink)]">
          通知
        </h3>
        <div className="pl-1">
          <NotificationConfigEditor
            value={draft.notification}
            onChange={(v) => setDraft((d) => ({ ...d, notification: v }))}
          />
        </div>
      </section>

      {errors.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-[12px] text-[var(--error)]">
          {errors[0]}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-[var(--line)] pt-4">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-[var(--radius-md)] px-3 py-1.5 text-[13px] font-medium text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || errors.length > 0}
          className="rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--accent-warm-hover)] disabled:opacity-50"
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}

/** Best-effort label for the task's workspace (path basename). The
 *  TaskEditPanel doesn't have direct access to the projects list, but a
 *  basename is enough context for the advanced editor's hint copy. */
function workspaceDisplayName(task: Task): string | undefined {
  const raw = task.workspacePath;
  if (!raw) return undefined;
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? raw;
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[13px] font-medium text-[var(--ink-secondary)]">
        {label}
        {hint && <span className="ml-2 text-[11px] text-[var(--ink-muted)]/70">{hint}</span>}
        {required && <span className="ml-1 text-[var(--accent-warm)]">*</span>}
      </label>
      {children}
    </div>
  );
}

/**
 * Section header for a task document editor (task.md / verify.md):
 *   - left: uppercased section title (matches other edit-panel sections)
 *   - center/right: the absolute file path the editor will write to,
 *     truncated on narrow widths
 *   - trailing: "打开文件夹" button that reveals the enclosing directory
 *     in Finder / Explorer / xdg-open so the user can inspect / edit the
 *     file with their preferred editor.
 *
 * Keeping the path visible is important because tasks are now user-data
 * (under `~/.myagents/tasks/<id>/`, PRD §9.3) — the mental model "the
 * file lives on disk, I can open it" should be reinforced, not hidden.
 */
function DocSectionHeader({
  title,
  hint,
  path,
  onOpenFolder,
}: {
  title: string;
  hint?: string;
  path: string;
  onOpenFolder: () => void;
}) {
  return (
    <div className="mb-3">
      {/* Title on its own row — 14px semibold, same as every other
          in-overlay section header (基本信息 / 执行模式 / 结束条件 /
          通知). That puts it one step above field labels (13px
          medium) and one step below the overlay's own title (16px),
          which is the hierarchy users expect inside a modal. */}
      <h3 className="text-[14px] font-semibold text-[var(--ink)]">
        {title}
        {hint && (
          <span className="ml-2 text-[12px] font-normal text-[var(--ink-muted)]/70">
            {hint}
          </span>
        )}
      </h3>
      {/* Path + 打开文件夹 on a dedicated row below the title. Prior
          layout crammed all three into one row which meant the path
          visually competed with the title for gravity. */}
      <div className="mt-1 flex items-center gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--ink-muted)]/70"
          title={path}
        >
          {path}
        </span>
        <button
          type="button"
          onClick={onOpenFolder}
          title="在文件管理器中打开该任务的文档目录"
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-md)] px-2 py-0.5 text-[11px] text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
        >
          <FolderOpen className="h-3 w-3" />
          打开文件夹
        </button>
      </div>
    </div>
  );
}


