import { useEffect, useMemo, useState } from 'react';
import { Download, FileText, Loader2, Package, RefreshCw, Trash2, UploadCloud } from 'lucide-react';

import { spaceErrorMessage, type SpaceSkill } from '@/api/spaceCloud';
import CustomSelect, { type SelectOption } from '@/components/CustomSelect';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import type { Project } from '@/config/types';
import {
  getSkillFileState,
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceActions,
  type SpaceSkillDetailState,
} from '@/pages/space/spaceStore';
import { formatDate } from '@/pages/space/spaceUi';

type SkillScreen = 'list' | 'detail';
type SkillDetailMode = 'overview' | 'files';

export function SkillsWorkspace({
  admin,
  skills,
  loading,
  selectedSkillId,
  projects,
  actions,
  skillDetailState,
  onSelectSkill,
  onRefresh,
  onUploaded,
}: {
  admin: boolean;
  skills: SpaceSkill[];
  loading: boolean;
  selectedSkillId: string | null;
  projects: Project[];
  actions: SpaceActions;
  skillDetailState?: SpaceSkillDetailState;
  onSelectSkill: (id: string) => void;
  onRefresh: () => Promise<void>;
  onUploaded: (id: string) => void;
}) {
  const toast = useToast();
  const [screen, setScreen] = useState<SkillScreen>('list');
  const [detailMode, setDetailMode] = useState<SkillDetailMode>('overview');
  const [uploading, setUploading] = useState(false);
  const selected = skills.find((skill) => skill.id === selectedSkillId) ?? null;

  const uploadSkill = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: '选择 Skill ZIP',
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setUploading(true);
      const result = await actions.uploadSkillZip({ filePath: selectedPath });
      toast.success(`已上传 ${result.name}`);
      await actions.refreshSkills({ force: true, silent: true });
      onUploaded(result.id);
      setScreen('detail');
      setDetailMode('overview');
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setUploading(false);
    }
  };

  const openSkill = (id: string) => {
    onSelectSkill(id);
    setScreen('detail');
    setDetailMode('overview');
  };

  return (
    <div className="grid min-h-0 flex-1 grid-rows-[58px_minmax(0,1fr)]">
      <section className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-elevated)]/60 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2.5 font-semibold text-[var(--ink-secondary)]">
          <Package className="h-4 w-4 shrink-0" />
          <span>官方 Skill 空间</span>
          <small className="truncate text-xs font-medium text-[var(--ink-muted)]">默认列表，点击后进入安装详情</small>
        </div>
        <div className="flex items-center gap-2">
          {admin && (
          <button
            type="button"
            disabled={uploading}
            onClick={() => void uploadSkill()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            上传 Skill
          </button>
          )}
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)]"
          >
            <RefreshCw className="h-4 w-4" />
            刷新
          </button>
        </div>
      </section>

      {screen === 'list' || !selected ? (
        <main className="min-h-0 overflow-y-auto px-6 pb-8 pt-5">
          <section className="mx-auto max-w-[1280px]" aria-label="Skill list">
            <div className="mb-3 grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-xs font-semibold text-[var(--ink-muted)]">
              <strong className="text-base font-semibold text-[var(--ink-secondary)]">{skills.length} skills</strong>
              <span className="inline-flex items-center gap-2">
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                官方上传 · 点击查看详情
              </span>
            </div>
            <div className="border-y border-[var(--line-subtle)]">
              {skills.length === 0 && loading ? (
                <div className="grid gap-0">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="min-h-[78px] border-b border-[var(--line-subtle)] py-4 last:border-b-0">
                      <div className="h-4 w-56 rounded-md bg-[var(--paper-inset)]" />
                      <div className="mt-3 h-3 w-80 rounded-md bg-[var(--paper-inset)]" />
                    </div>
                  ))}
                </div>
              ) : skills.length === 0 ? (
                <div className="grid min-h-44 place-items-center border-x border-dashed border-[var(--line-subtle)] text-sm text-[var(--ink-muted)]">
                  <div className="text-center">
                    <p>暂无 Skills</p>
                    {admin && (
                      <button
                        type="button"
                        disabled={uploading}
                        onClick={() => void uploadSkill()}
                        className="mt-3 inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                      >
                        {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                        上传 Skill
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                skills.map((skill, index) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => openSkill(skill.id)}
                    style={{ animationDelay: `${index * 42}ms` }}
                    className={`grid min-h-[78px] w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-[var(--line-subtle)] px-1 py-4 text-left transition-colors last:border-b-0 sm:px-3 ${
                      selectedSkillId === skill.id ? 'bg-[var(--paper-elevated)]/70 shadow-[inset_3px_0_0_var(--accent-warm)]' : 'hover:bg-[var(--paper-elevated)]/60'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="truncate text-base font-semibold leading-6 text-[var(--ink)]">{skill.name}</span>
                        <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">rev {skill.latestRevision}</span>
                        <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># official</span>
                      </span>
                      <span className="mt-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--ink-subtle)]">
                        <span>official</span>
                        <span className="before:mr-2 before:text-[var(--line-strong)] before:content-['·']">{formatDate(skill.updatedAt)}</span>
                        <span className="before:mr-2 before:text-[var(--line-strong)] before:content-['·']">点击查看详情</span>
                      </span>
                    </span>
                    <span className="hidden pt-1 text-xs font-semibold text-[var(--ink-subtle)] sm:block">{formatDate(skill.updatedAt)}</span>
                  </button>
                ))
              )}
            </div>
          </section>
        </main>
      ) : (
        <SkillDetailWorkspace
          skill={selected}
          mode={detailMode}
          admin={admin}
          projects={projects}
          actions={actions}
          detailState={skillDetailState}
          onModeChange={setDetailMode}
          onBack={() => setScreen('list')}
          onDeleted={() => setScreen('list')}
        />
      )}
    </div>
  );
}

function SkillDetailWorkspace({
  skill,
  mode,
  admin,
  projects,
  actions,
  detailState,
  onModeChange,
  onBack,
  onDeleted,
}: {
  skill: SpaceSkill;
  mode: SkillDetailMode;
  admin: boolean;
  projects: Project[];
  actions: SpaceActions;
  detailState?: SpaceSkillDetailState;
  onModeChange: (mode: SkillDetailMode) => void;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [selectedPath, setSelectedPath] = useState('');
  const [projectPath, setProjectPath] = useState(projects[0]?.path ?? '');
  const [installingTarget, setInstallingTarget] = useState<'global' | 'project' | null>(null);
  const [revisionUploading, setRevisionUploading] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const detail = detailState?.detail ?? null;
  const detailLoading = detailState?.isLoading ?? true;
  const fileState = selectedPath ? getSkillFileState(skill.id, selectedPath) : null;
  const fileLoading = fileState?.isLoading ?? false;
  const fileText = fileState?.text ?? '';

  const projectOptions = useMemo<SelectOption[]>(
    () => projects.map((project) => ({ value: project.path, label: project.displayName || project.name })),
    [projects],
  );
  const hasProjects = projectOptions.length > 0;

  useEffect(() => {
    setSelectedPath('');
    void actions.refreshSkillDetail(skill.id, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, skill.id, toast]);

  useEffect(() => {
    if (projectOptions.length === 0) {
      setProjectPath('');
      return;
    }
    if (!projectOptions.some((option) => option.value === projectPath)) {
      setProjectPath(projectOptions[0].value);
    }
  }, [projectOptions, projectPath]);

  useEffect(() => {
    if (!detail || selectedPath) return;
    const firstReadable = detail.files.find((file) => !file.isDir && file.name.toLowerCase() === 'skill.md') ?? detail.files.find((file) => !file.isDir);
    setSelectedPath(firstReadable?.path ?? '');
  }, [detail, selectedPath]);

  useEffect(() => {
    if (!selectedPath || mode !== 'files') return;
    void actions.refreshSkillFile(skill.id, selectedPath, { maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS }).catch((error) => toast.error(spaceErrorMessage(error)));
  }, [actions, mode, selectedPath, skill.id, toast]);

  const install = async (target: 'global' | 'project') => {
    const workspacePath = target === 'project' ? projectPath || projects[0]?.path : undefined;
    if (target === 'project' && !workspacePath) {
      toast.error('请选择目标工作区');
      return;
    }
    setInstallingTarget(target);
    try {
      const result = await actions.installSkill({
        skillId: skill.id,
        skillName: skill.name,
        target,
        workspacePath,
      });
      toast.success(`已安装到 ${result.target}`);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setInstallingTarget(null);
    }
  };

  const uploadRevision = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selectedPath = await open({
        multiple: false,
        directory: false,
        title: '选择 Skill Revision ZIP',
        filters: [{ name: 'Skill ZIP', extensions: ['zip'] }],
      });
      if (!selectedPath || Array.isArray(selectedPath)) return;
      setRevisionUploading(true);
      const result = await actions.uploadSkillRevision(skill.id, selectedPath);
      toast.success(`已更新到 rev ${result.latestRevision}`);
      await Promise.all([
        actions.refreshSkills({ force: true, silent: true }),
        actions.refreshSkillDetail(skill.id, { force: true, silent: true }),
      ]);
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setRevisionUploading(false);
    }
  };

  const deleteSkill = async () => {
    setDeleting(true);
    try {
      await actions.deleteSkill(skill.id);
      toast.success('Skill 已下架');
      setDeleteConfirmOpen(false);
      onDeleted();
      await actions.refreshSkills({ force: true, silent: true });
    } catch (error) {
      toast.error(spaceErrorMessage(error));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
    <main className="min-h-0 overflow-hidden p-[18px_20px_24px]">
      <div className="grid h-full min-h-0 grid-rows-[42px_minmax(0,1fr)]">
        <nav className="flex items-center gap-2 text-sm font-semibold text-[var(--ink-muted)]" aria-label="Skill breadcrumb">
          <button type="button" onClick={onBack} className="rounded-md px-2 py-1 font-semibold transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]">
            Skills
          </button>
          <span>›</span>
          <strong className="truncate font-semibold text-[var(--ink)]">{skill.name}</strong>
        </nav>

        <section className="grid min-h-0 grid-rows-[86px_minmax(0,1fr)] overflow-hidden border-y border-[var(--line-subtle)] bg-[var(--paper-elevated)]/30">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--line)] px-5">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold leading-tight text-[var(--ink)]">{skill.name}</h2>
            <p className="truncate text-sm text-[var(--ink-muted)]">{skill.description || 'No description'}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">rev {skill.latestRevision}</span>
              <span className="rounded-md bg-[var(--paper-inset)] px-2 py-1 text-xs font-semibold text-[var(--ink-muted)]">official</span>
              <span className="rounded-md bg-[var(--accent-cool-subtle)] px-2 py-1 text-xs font-semibold text-[var(--accent-cool)]"># Skill</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex h-9 items-center gap-1 rounded-xl bg-[var(--paper-inset)]/50 p-1">
              <button
                type="button"
                onClick={() => onModeChange('overview')}
                className={`h-7 rounded-lg px-2.5 text-sm font-semibold transition-colors ${mode === 'overview' ? 'bg-[var(--paper-elevated)] text-[var(--accent-warm)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
              >
                概览
              </button>
              <button
                type="button"
                onClick={() => onModeChange('files')}
                className={`h-7 rounded-lg px-2.5 text-sm font-semibold transition-colors ${mode === 'files' ? 'bg-[var(--paper-elevated)] text-[var(--accent-warm)] shadow-sm' : 'text-[var(--ink-muted)] hover:text-[var(--ink)]'}`}
              >
                文件
              </button>
            </div>
            {admin && (
              <>
                <button
                  type="button"
                  disabled={revisionUploading || deleting}
                  onClick={() => void uploadRevision()}
                  className="flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                >
                  {revisionUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                  更新版本
                </button>
                <button
                  type="button"
                  disabled={revisionUploading || deleting}
                  onClick={() => setDeleteConfirmOpen(true)}
                  className="flex h-9 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-[var(--error)] transition-colors hover:bg-[var(--error-bg)] disabled:cursor-wait disabled:opacity-70"
                >
                  {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  下架
                </button>
              </>
            )}
            <button
              type="button"
              disabled={installingTarget !== null}
              onClick={() => void install('global')}
              className="flex h-9 items-center gap-2 rounded-xl bg-[var(--button-secondary-bg)] px-3 text-sm font-semibold text-[var(--button-secondary-text)] transition-colors hover:bg-[var(--button-secondary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
            >
              {installingTarget === 'global' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              全局安装
            </button>
            {hasProjects ? (
              <CustomSelect value={projectPath} options={projectOptions} onChange={setProjectPath} className="w-48" />
            ) : (
              <span className="inline-flex h-9 items-center rounded-xl bg-[var(--paper-inset)]/60 px-3 text-sm font-semibold text-[var(--ink-muted)]">
                无项目工作区
              </span>
            )}
            <button
              type="button"
              disabled={installingTarget !== null || !hasProjects}
              title={hasProjects ? '安装到选中的项目' : '暂无可安装的项目工作区'}
              onClick={() => void install('project')}
              className="flex h-9 items-center gap-2 rounded-xl bg-[var(--button-primary-bg)] px-3 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {installingTarget === 'project' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              安装到项目
            </button>
          </div>
        </div>

        {!detail && detailLoading ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载 Skill
          </div>
        ) : !detail ? (
          <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
            {detailState?.error ?? 'Skill 未找到'}
          </div>
        ) : mode === 'overview' ? (
          <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_320px] overflow-auto max-lg:grid-cols-1">
            <section className="min-w-0 border-r border-[var(--line-subtle)] p-5 max-lg:border-r-0 max-lg:border-b">
              <h3 className="mb-3 text-base font-semibold text-[var(--ink)]">Overview</h3>
              <p className="whitespace-pre-wrap text-sm leading-6 text-[var(--ink-secondary)]">{detail.skill.description || 'No description'}</p>
            </section>
            <aside className="p-5">
              <h3 className="mb-3 text-sm font-semibold text-[var(--ink)]">安装影响</h3>
              <div className="space-y-2 text-sm text-[var(--ink-secondary)]">
                <div className="flex justify-between gap-3 border-b border-[var(--line-subtle)] pb-2">
                  <span className="text-[var(--ink-muted)]">Files</span>
                  <span>{detail.files.filter((file) => !file.isDir).length}</span>
                </div>
                <div className="flex justify-between gap-3 border-b border-[var(--line-subtle)] pb-2">
                  <span className="text-[var(--ink-muted)]">Updated</span>
                  <span>{formatDate(detail.skill.updatedAt)}</span>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="grid min-h-0 grid-cols-[270px_minmax(0,1fr)]">
            <aside className="min-h-0 overflow-auto border-r border-[var(--line)] bg-[var(--paper-inset)]/30 p-3">
              <div className="space-y-1">
                {detail.files.map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    disabled={file.isDir}
                    onClick={() => setSelectedPath(file.path)}
                    className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors ${
                      selectedPath === file.path
                        ? 'bg-[var(--hover-bg)] text-[var(--accent-warm)]'
                        : 'text-[var(--ink-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--accent-warm)]'
                    } ${file.isDir ? 'font-semibold opacity-80' : ''}`}
                  >
                    {file.isDir ? <Package className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 truncate">{file.path}</span>
                  </button>
                ))}
              </div>
            </aside>
            <section className="min-w-0 bg-[var(--paper-inset)]/50">
              {fileLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-[var(--ink-muted)]">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  加载文件
                </div>
              ) : (
                <pre className="h-full overflow-auto whitespace-pre-wrap p-5 font-mono text-sm leading-7 text-[var(--ink-secondary)]">{fileState?.error ?? (fileText || 'Select a file')}</pre>
              )}
            </section>
          </div>
        )}
        </section>
      </div>
    </main>
    {deleteConfirmOpen && (
      <ConfirmDialog
        title="下架 Skill"
        message={`确定要下架「${skill.name}」吗？下架后列表中不再展示，历史 revision 和审计记录会保留。`}
        confirmText="下架"
        cancelText="取消"
        confirmVariant="danger"
        loading={deleting}
        onConfirm={() => void deleteSkill()}
        onCancel={() => setDeleteConfirmOpen(false)}
      />
    )}
    </>
  );
}
