import { Check, Download, ExternalLink as ExternalLinkIcon, FolderOpen, Link2, Loader2, RefreshCw, Trash2, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import ConfirmDialog from '@/components/ConfirmDialog';
import CustomSelect from '@/components/CustomSelect';
import { ExternalLink } from '@/components/ExternalLink';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import { useConfig } from '@/hooks/useConfig';
import { useCloseLayer } from '@/hooks/useCloseLayer';
import { useTauriFileDrop } from '@/hooks/useTauriFileDrop';
import { track } from '@/analytics';
import { isTauriEnvironment } from '@/utils/browserMock';
import { shortenPathForDisplay } from '@/utils/pathDetection';
import { workspacePathsEqual } from '../../shared/workspacePath';
import {
    BUILTIN_PET_PACKS,
    BUILTIN_PET_PACK_IDS,
    DEFAULT_PET_PACK_ID,
    normalizeBuiltinPetPackId,
} from '@/floating-ball/defaultPetPack';
import {
    describeNativeFloatingBallError,
    setNativeFloatingBallEnabled,
} from '@/floating-ball/nativeFloatingBall';
import {
    deleteInstalledPetPack,
    importPetFromPath,
    importPetFromPetdex,
    importPetsFromCodex,
    installedPetRecordsToPacks,
    listInstalledPetPacks,
    type PetImportSummary,
} from '@/floating-ball/petPackLibrary';
import { PetSprite } from '@/floating-ball/PetSprite';
import type { PetPack } from '@/floating-ball/petAtlas';
import '@/floating-ball/fb.css';

function notifyBallConfigChanged() {
    if (!isTauriEnvironment()) return;
    void invoke('cmd_fb_relay', {
        target: 'ball',
        event: 'fb:config-changed',
        payload: {},
    }).catch((err) => {
        console.warn('[FloatingBallPetSettings] relay config change failed:', err);
    });
}

function formatImportToast(summary: PetImportSummary): string {
    if (summary.imported === 0 && summary.skipped === 0) return '没有发现可导入的 Codex Pets';
    if (summary.skipped > 0) return `已导入 ${summary.imported} 组，跳过 ${summary.skipped} 组`;
    return `已导入 ${summary.imported} 组桌宠素材`;
}

function PetStyleCard({
    pack,
    active,
    deleting = false,
    removable = false,
    onSelect,
    onDelete,
}: {
    pack: PetPack;
    active: boolean;
    deleting?: boolean;
    removable?: boolean;
    onSelect: () => void;
    onDelete?: () => void;
}) {
    const description = pack.description?.trim();

    return (
        <div
            className={`group relative rounded-xl border bg-[var(--paper)] transition-all ${
                active
                    ? 'border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-warm-subtle)]'
                    : 'border-[var(--line)] hover:border-[var(--ink-subtle)] hover:bg-[var(--paper-elevated)]'
            }`}
        >
            <button
                type="button"
                onClick={onSelect}
                disabled={deleting}
                className={`flex min-h-28 w-full items-center gap-4 rounded-xl p-4 text-left transition-opacity disabled:cursor-wait disabled:opacity-70 ${
                    removable ? 'pr-12' : ''
                }`}
            >
                <div className="flex h-20 w-20 shrink-0 items-center justify-center">
                    <PetSprite pack={pack} animation="idle" title={pack.displayName} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="line-clamp-1 min-w-0 text-base font-semibold text-[var(--ink)]">
                            {pack.displayName}
                        </span>
                        {active && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                    </div>
                    {description && (
                        <p className="mt-1 line-clamp-2 text-sm leading-6 text-[var(--ink-muted)]">
                            {description}
                        </p>
                    )}
                </div>
            </button>
            {removable && onDelete && (
                <button
                    type="button"
                    onClick={(event) => {
                        event.stopPropagation();
                        onDelete();
                    }}
                    disabled={deleting}
                    className={`absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--paper-elevated)] text-[var(--ink-muted)] shadow-sm transition-all hover:border-[var(--error)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--error-subtle)] disabled:cursor-wait ${
                        deleting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                    aria-label={`删除 ${pack.displayName}`}
                    title="删除"
                >
                    {deleting ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        <Trash2 className="h-4 w-4" />
                    )}
                </button>
            )}
        </div>
    );
}

function DeletePetConfirmDialog({
    target,
    deleting,
    onConfirm,
    onCancel,
}: {
    target: PetPack | null;
    deleting: boolean;
    onConfirm: (pack: PetPack) => void;
    onCancel: () => void;
}) {
    if (!target) return null;

    return (
        <ConfirmDialog
            title="删除桌宠素材"
            message={`确定要删除「${target.displayName}」吗？\n删除后这个素材会从本机导入列表移除。`}
            confirmText="删除"
            cancelText="取消"
            confirmVariant="danger"
            loading={deleting}
            onConfirm={() => onConfirm(target)}
            onCancel={onCancel}
        />
    );
}

function PetdexImportDialog({
    open,
    value,
    importing,
    onValueChange,
    onSubmit,
    onClose,
}: {
    open: boolean;
    value: string;
    importing: boolean;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    onClose: () => void;
}) {
    const inputRef = useRef<HTMLInputElement | null>(null);
    useCloseLayer(() => {
        if (!open) return false;
        if (importing) return true;
        onClose();
        return true;
    }, 50);

    useEffect(() => {
        if (!open) return;
        const frame = requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.select();
        });
        return () => cancelAnimationFrame(frame);
    }, [open]);

    if (!open) return null;

    return (
        <OverlayBackdrop onClose={importing ? undefined : onClose} className="z-50 px-4">
            <form
                className="w-full max-w-lg rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5 shadow-2xl"
                onSubmit={(event) => {
                    event.preventDefault();
                    onSubmit();
                }}
            >
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h3 className="text-lg font-semibold text-[var(--ink)]">Petdex 链接导入</h3>
                        <p className="mt-1 text-sm leading-6 text-[var(--ink-muted)]">
                            粘贴 Petdex 宠物页面链接，MyAgents 会下载 zip 包并按 Codex Pets 协议校验后导入。
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={importing}
                        className="rounded-lg p-1 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] disabled:cursor-wait disabled:opacity-60"
                        aria-label="关闭"
                    >
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <label className="mt-5 block text-sm font-medium text-[var(--ink)]" htmlFor="petdex-import-url">
                    Petdex 链接
                </label>
                <input
                    ref={inputRef}
                    id="petdex-import-url"
                    type="url"
                    value={value}
                    onChange={(event) => onValueChange(event.target.value)}
                    disabled={importing}
                    placeholder="例如 https://petdex.dev/pets/bluebow"
                    className="mt-2 w-full rounded-lg border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-base text-[var(--ink)] placeholder-[var(--ink-muted)] outline-none transition-colors focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 disabled:cursor-wait disabled:opacity-70"
                />

                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={importing}
                        className="rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-70"
                    >
                        取消
                    </button>
                    <button
                        type="submit"
                        disabled={importing || !value.trim()}
                        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70"
                    >
                        {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                        导入
                    </button>
                </div>
            </form>
        </OverlayBackdrop>
    );
}

export default function FloatingBallPetSettings() {
    const { config, updateConfig, projects, addProject } = useConfig();
    const toast = useToast();
    const [installedPacks, setInstalledPacks] = useState<PetPack[]>([]);
    const [loadingInstalled, setLoadingInstalled] = useState(false);
    const [importing, setImporting] = useState(false);
    const [petdexDialogOpen, setPetdexDialogOpen] = useState(false);
    const [petdexUrl, setPetdexUrl] = useState('');
    const [deleteTarget, setDeleteTarget] = useState<PetPack | null>(null);
    const [deletingPetId, setDeletingPetId] = useState<string | null>(null);
    const dropZoneRef = useRef<HTMLDivElement | null>(null);
    const refreshSeqRef = useRef(0);
    const mountedRef = useRef(true);

    const selectedPetId = normalizeBuiltinPetPackId(config.floatingBallPetId) ?? DEFAULT_PET_PACK_ID;
    const hoverPeekEnabled = config.floatingBallHoverPeekEnabled !== false;
    const stylePacks = useMemo<PetPack[]>(() => {
        const builtinIds = new Set(BUILTIN_PET_PACK_IDS);
        return [
            ...BUILTIN_PET_PACKS,
            ...installedPacks.filter((pack) => !builtinIds.has(pack.id)),
        ];
    }, [installedPacks]);
    const workspaceOptions = useMemo(
        () => [
            { value: '', label: '跟随默认工作区' },
            ...projects.map((project) => ({
                value: project.path,
                label: shortenPathForDisplay(project.path),
                icon: <FolderOpen className="h-3.5 w-3.5" />,
            })),
        ],
        [projects],
    );

    const refreshInstalled = useCallback(async () => {
        const seq = refreshSeqRef.current + 1;
        refreshSeqRef.current = seq;
        setLoadingInstalled(true);
        try {
            const packs = await listInstalledPetPacks();
            if (mountedRef.current && refreshSeqRef.current === seq) {
                setInstalledPacks(packs);
            }
        } catch (err) {
            console.warn('[FloatingBallPetSettings] list installed pets failed:', err);
            if (mountedRef.current && refreshSeqRef.current === seq) {
                toast.error(`读取已导入素材失败：${err instanceof Error ? err.message : String(err)}`);
            }
        } finally {
            if (mountedRef.current && refreshSeqRef.current === seq) {
                setLoadingInstalled(false);
            }
        }
    }, [toast]);

    useEffect(() => {
        mountedRef.current = true;
        void refreshInstalled();
        return () => {
            mountedRef.current = false;
        };
    }, [refreshInstalled]);

    const selectPetPack = useCallback(
        async (pack: PetPack) => {
            await updateConfig({
                floatingBallAppearance: 'pet',
                floatingBallPetId: pack.id,
            });
            notifyBallConfigChanged();
            track('floating_ball_pet_select', { pet_id: pack.id, source: pack.source ?? 'builtin' });
        },
        [updateConfig],
    );

    const deletePetPack = useCallback(
        async (pack: PetPack) => {
            if (pack.source !== 'imported' || deletingPetId) return;
            setDeletingPetId(pack.id);
            try {
                await deleteInstalledPetPack(pack.id);
                if (selectedPetId === pack.id) {
                    await updateConfig({ floatingBallPetId: DEFAULT_PET_PACK_ID });
                    if ((config.floatingBallAppearance ?? 'pet') === 'pet') {
                        notifyBallConfigChanged();
                    }
                }
                await refreshInstalled();
                setDeleteTarget(null);
                toast.success('已删除桌宠素材');
            } catch (err) {
                toast.error(`删除桌宠素材失败：${err instanceof Error ? err.message : String(err)}`);
            } finally {
                if (mountedRef.current) {
                    setDeletingPetId(null);
                }
            }
        },
        [config.floatingBallAppearance, deletingPetId, refreshInstalled, selectedPetId, toast, updateConfig],
    );

    const setEnabled = useCallback(
        async (enabled: boolean) => {
            try {
                await setNativeFloatingBallEnabled(enabled);
            } catch (err) {
                toast.error(`${enabled ? '启用' : '关闭'}桌面宠物失败：${describeNativeFloatingBallError(err)}`);
                return;
            }

            await updateConfig({ floatingBallEnabled: enabled });
            track('floating_ball_toggle', { gate: false, enabled });
            toast.success(enabled ? '已启用桌面宠物' : '已关闭桌面宠物');
        },
        [toast, updateConfig],
    );

    const importPaths = useCallback(
        async (paths: string[]) => {
            if (paths.length === 0) return;
            setImporting(true);
            let imported = 0;
            let skipped = 0;
            const importedPacks: PetPack[] = [];
            try {
                for (const path of paths) {
                    try {
                        const summary = await importPetFromPath(path);
                        imported += summary.imported;
                        skipped += summary.skipped;
                        importedPacks.push(...installedPetRecordsToPacks(summary.pets));
                    } catch (err) {
                        skipped += 1;
                        console.warn('[FloatingBallPetSettings] import path failed:', path, err);
                    }
                }
                await refreshInstalled();
                if (importedPacks.length > 0) {
                    await selectPetPack(importedPacks[0]);
                }
                toast.success(formatImportToast({ imported, skipped, pets: [] }));
            } finally {
                setImporting(false);
            }
        },
        [refreshInstalled, selectPetPack, toast],
    );

    const importFromCodex = useCallback(async () => {
        setImporting(true);
        try {
            const summary = await importPetsFromCodex();
            const packs = installedPetRecordsToPacks(summary.pets);
            await refreshInstalled();
            if (packs.length > 0) {
                await selectPetPack(packs[0]);
            }
            toast.success(formatImportToast(summary));
        } catch (err) {
            toast.error(`从 Codex 导入失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setImporting(false);
        }
    }, [refreshInstalled, selectPetPack, toast]);

    const importFromPetdex = useCallback(async () => {
        const url = petdexUrl.trim();
        if (!url) {
            toast.error('请输入 Petdex 链接');
            return;
        }
        setImporting(true);
        try {
            const summary = await importPetFromPetdex(url);
            const packs = installedPetRecordsToPacks(summary.pets);
            await refreshInstalled();
            if (packs.length > 0) {
                await selectPetPack(packs[0]);
            }
            setPetdexDialogOpen(false);
            setPetdexUrl('');
            toast.success(formatImportToast(summary));
        } catch (err) {
            toast.error(`Petdex 链接导入失败：${err instanceof Error ? err.message : String(err)}`);
        } finally {
            setImporting(false);
        }
    }, [petdexUrl, refreshInstalled, selectPetPack, toast]);

    const chooseFile = useCallback(async () => {
        try {
            const { open } = await import('@tauri-apps/plugin-dialog');
            const selected = await open({
                multiple: true,
                title: '选择 Codex Pets .zip 文件',
                filters: [
                    { name: 'Codex Pets ZIP', extensions: ['zip'] },
                ],
            });
            if (!selected) return;
            await importPaths(Array.isArray(selected) ? selected : [selected]);
        } catch (err) {
            toast.error(`选择文件失败：${err instanceof Error ? err.message : String(err)}`);
        }
    }, [importPaths, toast]);

    const { isDragging, activeZoneId, registerZone, unregisterZone } = useTauriFileDrop();

    useEffect(() => {
        registerZone('floating-pet-import', dropZoneRef.current, (paths) => {
            void importPaths(paths);
        });
        return () => unregisterZone('floating-pet-import');
    }, [importPaths, registerZone, unregisterZone]);

    return (
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-8">
            <PetdexImportDialog
                open={petdexDialogOpen}
                value={petdexUrl}
                importing={importing}
                onValueChange={setPetdexUrl}
                onSubmit={() => void importFromPetdex()}
                onClose={() => setPetdexDialogOpen(false)}
            />
            <DeletePetConfirmDialog
                target={deleteTarget}
                deleting={!!deleteTarget && deletingPetId === deleteTarget.id}
                onConfirm={(pack) => void deletePetPack(pack)}
                onCancel={() => {
                    if (deletingPetId) return;
                    setDeleteTarget(null);
                }}
            />
            <div className="mb-8">
                <h2 className="text-xl font-semibold text-[var(--ink)]">桌面宠物</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-muted)]">
                    悬浮桌面宠物伴你在任何时刻唤起 MyAgents，与 AI 对话或发起任务。
                </p>
            </div>

            <div className="space-y-6">
                <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 sm:p-5">
                    <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                        <div>
                            <h3 className="text-base font-medium text-[var(--ink)]">启用</h3>
                            <p className="mt-1 text-sm text-[var(--ink-muted)]">
                                显示桌面悬浮入口和伴侣窗口。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void setEnabled(!config.floatingBallEnabled)}
                            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                config.floatingBallEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                            }`}
                            aria-pressed={!!config.floatingBallEnabled}
                        >
                            <span
                                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                    config.floatingBallEnabled ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </section>

                <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 sm:p-5">
                    <h3 className="text-base font-medium text-[var(--ink)]">通用设置</h3>
                    <div className="mt-4 flex flex-col items-stretch gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-[var(--ink)]">绑定工作区</p>
                            <p className="mt-1 text-sm text-[var(--ink-muted)]">
                                默认跟随启动页工作区，也可以固定到某个项目。
                            </p>
                        </div>
                        <CustomSelect
                            value={config.floatingBallWorkspaceOverride ?? ''}
                            size="md"
                            options={workspaceOptions}
                            onChange={async (value) => {
                                const next = value || null;
                                if (next && !projects.find((project) => workspacePathsEqual(project.path, next))) {
                                    await addProject(next);
                                }
                                await updateConfig({ floatingBallWorkspaceOverride: next });
                                toast.success('工作区绑定已更新');
                            }}
                            className="w-full shrink-0 sm:w-72"
                        />
                    </div>
                    <div className="mt-4 flex flex-col items-start gap-4 border-t border-[var(--line)] pt-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-[var(--ink)]">悬停预览浮窗</p>
                            <p className="mt-1 text-sm text-[var(--ink-muted)]">
                                鼠标移到悬浮球上时自动展开半透明浮窗；关闭后点击悬浮球仍可打开。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={async () => {
                                const next = !hoverPeekEnabled;
                                await updateConfig({ floatingBallHoverPeekEnabled: next });
                                notifyBallConfigChanged();
                                toast.success(next ? '已开启悬停预览浮窗' : '已关闭悬停预览浮窗');
                            }}
                            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
                                hoverPeekEnabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'
                            }`}
                            aria-pressed={hoverPeekEnabled}
                        >
                            <span
                                className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${
                                    hoverPeekEnabled ? 'translate-x-5' : 'translate-x-0'
                                }`}
                            />
                        </button>
                    </div>
                </section>

                <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 sm:p-5">
                    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                        <div>
                            <h3 className="text-base font-medium text-[var(--ink)]">宠物样式</h3>
                            <p className="mt-1 max-w-2xl text-sm leading-6 text-[var(--ink-muted)]">
                                内置样式和导入素材都使用 Codex Pets 的 9 状态 spritesheet 协议，运行时会按当前 Agent 状态切换动作。
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={() => void refreshInstalled()}
                            className="self-end rounded-lg p-2 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)] sm:self-auto"
                            title="刷新导入素材"
                        >
                            {loadingInstalled ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                        </button>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                        {stylePacks.map((pack) => (
                            <PetStyleCard
                                key={pack.id}
                                pack={pack}
                                active={(config.floatingBallAppearance ?? 'pet') === 'pet' && selectedPetId === pack.id}
                                deleting={deletingPetId === pack.id}
                                removable={pack.source === 'imported'}
                                onSelect={() => void selectPetPack(pack)}
                                onDelete={() => setDeleteTarget(pack)}
                            />
                        ))}
                    </div>

                    <div
                        ref={dropZoneRef}
                        className={`mt-5 rounded-xl border border-dashed p-8 transition-colors ${
                            isDragging && activeZoneId === 'floating-pet-import'
                                ? 'border-[var(--accent)] bg-[var(--accent-warm-subtle)]'
                                : 'border-[var(--line-strong)] bg-[var(--paper)]'
                        }`}
                    >
                        <div className="flex min-h-44 w-full flex-col items-center justify-center text-center">
                            <UploadCloud className="h-8 w-8 text-[var(--ink-muted)]" />
                            <h4 className="mt-4 text-base font-semibold text-[var(--ink)]">拖拽导入 Codex Pets 素材</h4>
                            <p className="mt-2 max-w-xl whitespace-normal break-words text-sm leading-6 text-[var(--ink-muted)]">
                                拖入包含 pet.json 和 spritesheet.webp/png 的文件夹或 Codex Pets .zip 文件，导入时会校验 9 状态素材尺寸与 manifest 引用。
                            </p>
                            <div className="mt-5 flex w-full flex-col items-stretch gap-2 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-2 shadow-sm lg:w-auto lg:flex-row lg:items-center lg:gap-3">
                                <button
                                    type="button"
                                    onClick={() => void importFromCodex()}
                                    disabled={importing}
                                    className="inline-flex w-full min-w-0 flex-wrap items-center justify-center gap-2 whitespace-normal rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:cursor-wait disabled:opacity-70 lg:w-auto"
                                >
                                    {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                    从 Codex 导入
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void chooseFile()}
                                    disabled={importing}
                                    className="inline-flex w-full min-w-0 flex-wrap items-center justify-center gap-2 whitespace-normal rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-70 lg:w-auto"
                                >
                                    <FolderOpen className="h-4 w-4" />
                                    选择 .zip 文件
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setPetdexDialogOpen(true)}
                                    disabled={importing}
                                    className="inline-flex w-full min-w-0 flex-wrap items-center justify-center gap-2 whitespace-normal rounded-lg border border-[var(--line)] bg-[var(--paper)] px-4 py-2 text-sm font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--paper-inset)] disabled:cursor-wait disabled:opacity-70 lg:w-auto"
                                >
                                    <Link2 className="h-4 w-4" />
                                    Petdex 链接导入
                                </button>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-4 sm:p-5">
                    <h3 className="text-base font-medium text-[var(--ink)]">下载网站推荐</h3>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <ExternalLink
                            href="https://petdex.dev"
                            className="flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink)] transition-colors hover:border-[var(--ink-subtle)] hover:bg-[var(--paper-inset)]"
                        >
                            <span>
                                <span className="block font-semibold">Petdex</span>
                                <span className="mt-1 block text-[var(--ink-muted)]">Codex Pets 公共素材库</span>
                            </span>
                            <ExternalLinkIcon className="h-4 w-4 text-[var(--ink-muted)]" />
                        </ExternalLink>
                        <ExternalLink
                            href="https://github.com/topics/codex-pet"
                            className="flex items-center justify-between rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 text-sm text-[var(--ink)] transition-colors hover:border-[var(--ink-subtle)] hover:bg-[var(--paper-inset)]"
                        >
                            <span>
                                <span className="block font-semibold">GitHub Topic</span>
                                <span className="mt-1 block text-[var(--ink-muted)]">社区开源 Codex Pet 项目</span>
                            </span>
                            <ExternalLinkIcon className="h-4 w-4 text-[var(--ink-muted)]" />
                        </ExternalLink>
                    </div>
                </section>
            </div>
        </div>
    );
}
