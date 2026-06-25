import { useMemo, useState } from 'react';
import { Bot, Loader2, Plus, Power, PowerOff, RefreshCw, Settings, Trash2, X } from 'lucide-react';

import type { LocalRegisteredAgent } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { spaceErrorMessage } from '@/api/spaceCloud';
import { formatAgentSecondaryLabel } from '@/pages/space/spaceHelpers';
import type { SpaceActions } from '@/pages/space/spaceStore';
import { formatTime } from '@/pages/space/spaceUi';

function initials(value?: string | null): string {
  const source = value?.trim() || 'MA';
  const words = source.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function isAgentAssignable(agent: LocalRegisteredAgent): boolean {
  return agent.status === 'active' || agent.status === 'online';
}

export function AgentsWorkspace({
  admin,
  agents,
  projects,
  actions,
  onRefresh,
  onProcessDispatches,
  onRegister,
}: {
  admin: boolean;
  agents: LocalRegisteredAgent[];
  projects: Project[];
  actions: SpaceActions;
  onRefresh: () => Promise<void>;
  onProcessDispatches: () => Promise<void>;
  onRegister: () => void;
}) {
  const toast = useToast();
  const [processing, setProcessing] = useState(false);
  const [busyAgentId, setBusyAgentId] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<LocalRegisteredAgent | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<LocalRegisteredAgent | null>(null);
  const hasAssignableAgent = agents.some(isAgentAssignable);

  const process = async () => {
    setProcessing(true);
    try {
      await onProcessDispatches();
    } finally {
      setProcessing(false);
    }
  };

  const toggleAgentStatus = async (agent: LocalRegisteredAgent) => {
    const nextStatus = agent.status === 'disabled' ? 'active' : 'disabled';
    setBusyAgentId(agent.id);
    try {
      await actions.updateRegisteredAgent({ id: agent.id, status: nextStatus });
      toast.success(nextStatus === 'active' ? 'Agent 已启用' : 'Agent 已禁用');
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyAgentId(null);
    }
  };

  const revokeAgent = async () => {
    if (!revokeTarget) return;
    setBusyAgentId(revokeTarget.id);
    try {
      await actions.revokeRegisteredAgent(revokeTarget.id);
      toast.success('Agent 已撤销');
      setRevokeTarget(null);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusyAgentId(null);
    }
  };

  return (
    <>
      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)]">
        <section className="flex min-h-12 items-center gap-2.5 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-1.5 backdrop-blur-md">
          <div className="mr-auto flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--ink-secondary)]">
            <Bot className="h-4 w-4 shrink-0" />
            <span>Agents</span>
            <span className="rounded-md bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-semibold text-[var(--ink-muted)]">{agents.length}</span>
            <small className="truncate text-xs font-medium text-[var(--ink-muted)]">登记本地工作区，订阅并响应云端派发</small>
          </div>
          <button
            type="button"
            disabled={processing || !hasAssignableAgent}
            onClick={() => void process()}
            className="flex h-9 shrink-0 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {processing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            同步
          </button>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-transparent text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
            aria-label="刷新"
            title="刷新"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          {admin && (
            <button
              type="button"
              onClick={onRegister}
              className="flex h-9 shrink-0 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            >
              <Plus className="h-4 w-4" />
              登记
            </button>
          )}
        </section>
        <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-3">
          {agents.length === 0 ? (
            <div className="grid h-40 place-items-center rounded-[20px] border border-dashed border-[var(--line)] bg-[var(--paper-elevated)]/40 text-sm text-[var(--ink-muted)]">
              <div className="text-center">
                <Bot className="mx-auto mb-3 h-8 w-8 text-[var(--ink-muted)]" />
                <p>暂无 Registered Agents</p>
                {admin && (
                  <button
                    type="button"
                    onClick={onRegister}
                    className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
                  >
                    <Plus className="h-4 w-4" />
                    登记 Agent
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="max-w-[1180px]">
              <div className="border-y border-[var(--line-subtle)]">
                {agents.map((agent) => (
                  <article key={agent.id} className="border-b border-[var(--line-subtle)] px-2 py-3 last:border-b-0">
                    <div className="grid grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-2.5">
                      <span className="grid h-[34px] w-[34px] place-items-center rounded-xl bg-[var(--accent-cool-subtle)] text-xs font-bold text-[var(--accent-cool)]">
                        {initials(agent.displayName)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-[var(--ink)]">{agent.displayName}</h3>
                        <p className="truncate text-xs text-[var(--ink-muted)]">{formatAgentSecondaryLabel(agent, projects)}</p>
                      </div>
                      <span className="flex items-center gap-1.5">
                        <span className={`rounded-md px-2 py-1 text-xs font-semibold ${agent.status === 'active' || agent.status === 'online' ? 'bg-[var(--success-bg)] text-[var(--success)]' : 'bg-[var(--paper-inset)] text-[var(--ink-muted)]'}`}>{agent.status}</span>
                        {admin && (
                          <>
                            <button
                              type="button"
                              disabled={busyAgentId === agent.id || agent.status === 'revoked'}
                              onClick={() => setEditingAgent(agent)}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-not-allowed disabled:opacity-45"
                              aria-label={`编辑 Agent ${agent.displayName}`}
                              title="编辑"
                            >
                              <Settings className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              disabled={busyAgentId === agent.id || agent.status === 'revoked'}
                              onClick={() => void toggleAgentStatus(agent)}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-45"
                              aria-label={`${agent.status === 'disabled' ? '启用' : '禁用'} Agent ${agent.displayName}`}
                              title={agent.status === 'disabled' ? '启用' : '禁用'}
                            >
                              {busyAgentId === agent.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : agent.status === 'disabled' ? (
                                <Power className="h-4 w-4" />
                              ) : (
                                <PowerOff className="h-4 w-4" />
                              )}
                            </button>
                            <button
                              type="button"
                              disabled={busyAgentId === agent.id || agent.status === 'revoked'}
                              onClick={() => setRevokeTarget(agent)}
                              className="grid h-8 w-8 place-items-center rounded-lg text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-not-allowed disabled:opacity-45"
                              aria-label={`撤销 Agent ${agent.displayName}`}
                              title="撤销"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-2 pl-[46px]">
                      <div className="flex flex-wrap gap-2">
                        <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># agent</span>
                      </div>
                      <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">{formatTime(agent.updatedAt) || '未同步'}</span>
                    </div>
                    <details className="mt-3 border-t border-dashed border-[var(--line-subtle)] pt-2.5 pl-[46px]">
                      <summary className="inline-flex cursor-pointer list-none items-center gap-2 text-sm font-semibold text-[var(--ink-muted)] hover:text-[var(--ink)] [&::-webkit-details-marker]:hidden">
                        <Settings className="h-4 w-4" />
                        查看登记设置
                      </summary>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        <AgentStat label="Status" value={agent.status} />
                        <AgentStat label="Last sync" value={formatTime(agent.updatedAt) || 'n/a'} />
                        <AgentStat label="Workspace" value={agent.workspaceLabel || 'local'} />
                      </div>
                      <div className="mt-3 whitespace-pre-wrap rounded-xl bg-[var(--paper-inset)]/40 p-3 text-sm leading-6 text-[var(--ink-secondary)]">
                        Goal:
                        {'\n'}
                        {agent.goalMd}
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
      {editingAgent && (
        <EditAgentDialog
          agent={editingAgent}
          actions={actions}
          onClose={() => setEditingAgent(null)}
          onSaved={() => setEditingAgent(null)}
        />
      )}
      {revokeTarget && (
        <ConfirmDialog
          title="撤销 Registered Agent"
          message={`确定要撤销「${revokeTarget.displayName}」吗？撤销后该本地节点的 token 将失效，不能再接收新的派发。`}
          confirmText="撤销"
          cancelText="取消"
          confirmVariant="danger"
          loading={busyAgentId === revokeTarget.id}
          onConfirm={() => void revokeAgent()}
          onCancel={() => setRevokeTarget(null)}
        />
      )}
    </>
  );
}

function EditAgentDialog({
  agent,
  actions,
  onClose,
  onSaved,
}: {
  agent: LocalRegisteredAgent;
  actions: SpaceActions;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [workspaceLabel, setWorkspaceLabel] = useState(agent.workspaceLabel ?? '');
  const [goalMd, setGoalMd] = useState(agent.goalMd);
  const [busy, setBusy] = useState(false);

  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const submit = async () => {
    if (!displayName.trim() || !goalMd.trim()) return;
    setBusy(true);
    try {
      await actions.updateRegisteredAgent({
        id: agent.id,
        displayName: displayName.trim(),
        workspaceLabel: workspaceLabel.trim(),
        goalMd: goalMd.trim(),
      });
      toast.success('Registered Agent 已更新');
      onSaved();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">Edit Agent</h2>
            <p className="text-sm text-[var(--ink-muted)]">{agent.id}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Workspace label</span>
            <input
              value={workspaceLabel}
              onChange={(event) => setWorkspaceLabel(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Goal</span>
            <textarea
              value={goalMd}
              onChange={(event) => setGoalMd(event.target.value)}
              className="h-44 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button type="button" onClick={onClose} disabled={busy} className="h-10 rounded-xl bg-[var(--button-secondary-bg)] px-4 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:opacity-60">
            取消
          </button>
          <button
            type="button"
            disabled={busy || !displayName.trim() || !goalMd.trim()}
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-4 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            保存
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}

function AgentStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-h-14 border-b border-[var(--line-subtle)] px-1 py-2">
      <span className="block text-xs font-semibold text-[var(--ink-muted)]">{label}</span>
      <strong className="mt-1 block truncate font-mono text-base leading-tight text-[var(--ink)]">{value}</strong>
    </div>
  );
}

export function RegisterAgentDialog({
  projects,
  actions,
  onClose,
  onRegistered,
}: {
  projects: Project[];
  actions: SpaceActions;
  onClose: () => void;
  onRegistered: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [workspaceId, setWorkspaceId] = useState(projects[0]?.id ?? '');
  const [goalMd, setGoalMd] = useState('');
  const [busy, setBusy] = useState(false);
  useCloseLayer(() => {
    onClose();
    return true;
  }, 220);

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.id, label: project.displayName || project.name })),
    [projects],
  );

  const submit = async () => {
    const project = projects.find((item) => item.id === workspaceId);
    if (!project || !displayName.trim() || !goalMd.trim()) return;
    setBusy(true);
    try {
      await actions.registerAgent({
        displayName: displayName.trim(),
        workspaceId: project.id,
        workspacePath: project.path,
        workspaceLabel: project.displayName || project.name,
        goalMd: goalMd.trim(),
      });
      toast.success('Registered Agent 已创建');
      onRegistered();
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <OverlayBackdrop onClose={onClose} className="z-[220] items-center justify-center bg-black/20 backdrop-blur-sm">
      <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--ink)]">Register Agent</h2>
            <p className="text-sm text-[var(--ink-muted)]">Official Space</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Name</span>
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              className="h-10 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 text-sm text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              placeholder="Agent display name"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Workspace</span>
            <CustomSelect value={workspaceId} options={projectOptions} onChange={setWorkspaceId} size="md" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-[var(--ink)]">Goal</span>
            <textarea
              value={goalMd}
              onChange={(event) => setGoalMd(event.target.value)}
              className="h-44 w-full resize-none rounded-lg border border-[var(--line)] bg-[var(--paper)] p-3 text-sm leading-6 text-[var(--ink)] outline-none transition-colors focus:border-[var(--accent-warm)]"
              placeholder="Describe what this registered agent should handle."
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[var(--line)] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-lg px-4 text-sm font-medium text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !workspaceId || !displayName.trim() || !goalMd.trim()}
            onClick={() => void submit()}
            className="flex h-10 items-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bot className="h-4 w-4" />}
            Register
          </button>
        </div>
      </div>
    </OverlayBackdrop>
  );
}
