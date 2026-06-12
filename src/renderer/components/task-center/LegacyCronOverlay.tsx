// LegacyCronOverlay — read-only-ish overlay for CronTasks predating v0.1.69.
// PRD §11.4: share overlay chrome with the new task detail overlay, but the
// inner content shows legacy fields + a CTA to operate the cron via its
// normal cron panel (start/stop/delete wired to the existing cron commands).

import { useCallback, useState } from 'react';
import { X, Play, Square, Trash2, ArrowUpCircle } from 'lucide-react';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useConfig } from '@/hooks/useConfig';
import type { Task } from '@/../shared/types/task';
import { upgradeLegacyCron, type LegacyCronRaw } from './legacyUpgrade';

const OVERLAY_Z = 200;

interface Props {
  legacy: Record<string, unknown>;
  onClose: () => void;
  onChanged: () => void;
  /** Fired when the user upgrades this cron to a new-model Task. Parent
   *  should close this overlay and open `TaskDetailOverlay` for the new id. */
  onUpgraded?: (task: Task) => void;
}

export function LegacyCronOverlay({ legacy, onClose, onChanged, onUpgraded }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { projects } = useConfig();
  useCloseLayer(() => {
    onClose();
    return true;
  }, OVERLAY_Z);

  const id = String(legacy.id ?? '');
  const name = String(legacy.name ?? legacy.prompt ?? '未命名定时任务');
  const prompt = String(legacy.prompt ?? '');
  const status = String(legacy.status ?? 'stopped');
  const workspacePath = String(legacy.workspacePath ?? '');
  const createdAt = legacy.createdAt ? String(legacy.createdAt) : '';
  const schedule = (legacy.schedule as Record<string, unknown> | undefined) ?? null;
  const isRunning = status === 'running';

  const scheduleLabel = describeSchedule(schedule);

  const callCronCmd = useCallback(
    async (cmd: 'cmd_start_cron_task' | 'cmd_stop_cron_task' | 'cmd_delete_cron_task') => {
      if (!id) return;
      setBusy(true);
      setErr(null);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke(cmd, { taskId: id });
        onChanged();
        if (cmd === 'cmd_delete_cron_task') onClose();
      } catch (e) {
        setErr(String(e));
      } finally {
        setBusy(false);
      }
    },
    [id, onChanged, onClose],
  );

  const doDelete = useCallback(async () => {
    if (!window.confirm(`确认删除遗留定时任务「${name}」？此操作不可恢复。`)) return;
    void callCronCmd('cmd_delete_cron_task');
  }, [callCronCmd, name]);

  const doUpgrade = useCallback(async () => {
    if (!onUpgraded) return;
    const sure = window.confirm(
      `将「${name}」升级为新版任务？\n\n` +
        `升级后：\n` +
        `• 自动创建源想法（内容 = 原始 Prompt）\n` +
        `• 新任务继承当前调度、结束条件、通知、运行配置\n` +
        `• 现有调度不中断、执行历史保留\n` +
        `• 下次打开将进入新版任务详情（支持编辑 / 审计链 / 验收标准）`,
    );
    if (!sure) return;
    setBusy(true);
    setErr(null);
    try {
      const { task } = await upgradeLegacyCron(legacy as LegacyCronRaw, projects);
      onUpgraded(task);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [legacy, projects, onUpgraded, name]);

  return (
    <OverlayBackdrop onClose={onClose} className="z-[200]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-[min(640px,92vw)] flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-[var(--paper-elevated)] shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <div className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
              遗留定时任务
            </div>
            <h2 className="mt-1.5 text-lg font-semibold text-[var(--ink)]">
              {name}
            </h2>
            <p className="mt-1 text-xs text-[var(--ink-muted)]">
              这是 v0.1.69 之前创建的定时任务，不含新任务中心的对齐文档。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            title="关闭 (Cmd+W)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[var(--line-subtle)] px-5 py-3">
          {isRunning ? (
            <ActionBtn
              icon={<Square className="h-3.5 w-3.5" />}
              label="暂停"
              disabled={busy}
              variant="danger"
              onClick={() => void callCronCmd('cmd_stop_cron_task')}
            />
          ) : (
            <ActionBtn
              icon={<Play className="h-3.5 w-3.5" />}
              label="启动"
              disabled={busy}
              onClick={() => void callCronCmd('cmd_start_cron_task')}
            />
          )}
          {onUpgraded && (
            <ActionBtn
              icon={<ArrowUpCircle className="h-3.5 w-3.5" />}
              label="升级为新版任务"
              variant="accent"
              disabled={busy}
              onClick={doUpgrade}
            />
          )}
          <div className="flex-1" />
          <ActionBtn
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label="删除"
            variant="danger"
            disabled={busy}
            onClick={doDelete}
          />
        </div>

        {err && (
          <div className="border-b border-[var(--error)]/30 bg-[var(--error-bg)] px-5 py-2 text-xs text-[var(--error)]">
            {err}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-[var(--ink-muted)]/70">状态</dt>
            <dd className="text-[var(--ink)]">{isRunning ? '进行中' : '已暂停'}</dd>
            <dt className="text-[var(--ink-muted)]/70">工作区</dt>
            <dd className="truncate text-[var(--ink)]">{workspacePath || '—'}</dd>
            <dt className="text-[var(--ink-muted)]/70">调度方式</dt>
            <dd className="text-[var(--ink)]">{scheduleLabel}</dd>
            <dt className="text-[var(--ink-muted)]/70">创建</dt>
            <dd className="text-[var(--ink)]">{createdAt || '—'}</dd>
          </dl>

          {prompt && (
            <div className="mt-4 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper)] p-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                原始 Prompt
              </div>
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--ink-secondary)]">
                {prompt}
              </div>
            </div>
          )}

          <p className="mt-4 text-xs leading-relaxed text-[var(--ink-muted)]">
            遗留任务保留原有调度逻辑，执行记录仍可在对话 Tab 的定时面板中查看。
            点击上方「升级为新版任务」即可获得完整的任务详情（可编辑 Prompt /
            调度 / 通知、审计链、验收标准），原调度不中断。
          </p>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function describeSchedule(s: Record<string, unknown> | null): string {
  if (!s) return '固定间隔';
  const kind = s.kind as string | undefined;
  if (kind === 'every') return `每 ${String(s.minutes ?? '?')} 分钟`;
  if (kind === 'at') return `${String(s.at ?? '?')} 一次性`;
  if (kind === 'cron') return `Cron 表达式：${String(s.expr ?? '?')}`;
  if (kind === 'loop') return 'Ralph Loop';
  return '固定间隔';
}

interface ActionBtnProps {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'danger' | 'accent';
}

function ActionBtn({ icon, label, onClick, disabled, variant }: ActionBtnProps) {
  const base =
    'flex items-center gap-1.5 rounded-[var(--radius-md)] px-2.5 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const variantCls =
    variant === 'danger'
      ? 'text-[var(--ink-muted)] hover:bg-[var(--error-bg)] hover:text-[var(--error)]'
      : variant === 'accent'
        ? 'text-[var(--accent-warm)] hover:bg-[var(--accent-warm-subtle)]'
        : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${variantCls}`}
    >
      {icon}
      {label}
    </button>
  );
}

export default LegacyCronOverlay;
