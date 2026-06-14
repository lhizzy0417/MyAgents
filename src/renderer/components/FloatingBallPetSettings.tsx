import { Check, Download, ExternalLink as ExternalLinkIcon, FolderOpen, Link2, Loader2, RefreshCw, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

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
import { BUILTIN_PET_PACKS } from '@/floating-ball/defaultPetPack';
import {
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

interface FbCapabilities {
    supported: boolean;
    active: boolean;
}

function notifyBallAppearanceChanged() {
    if (!isTauriEnvironment()) return;
    void invoke('cmd_fb_relay', {
        target: 'ball',
        event: 'fb:appearance-changed',
        payload: {},
    }).catch((err) => {
        console.warn('[FloatingBallPetSettings] relay appearance change failed:', err);
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
    onSelect,
}: {
    pack: PetPack;
    active: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={`group flex min-h-32 flex-col items-start gap-3 rounded-xl border bg-[var(--paper)] p-4 text-left transition-all sm:flex-row sm:items-center sm:gap-4 ${
                active
                    ? 'border-[var(--accent)] shadow-[0_0_0_3px_var(--accent-warm-subtle)]'
                    : 'border-[var(--line)] hover:border-[var(--ink-subtle)] hover:bg-[var(--paper-elevated)]'
            }`}
        >
            <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-xl bg-[var(--paper-inset)]">
                <PetSprite pack={pack} animation="idle" title={pack.displayName} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="truncate text-base font-semibold text-[var(--ink)]">{pack.displayName}</span>
                    {active && <Check className="h-4 w-4 shrink-0 text-[var(--accent)]" />}
                </div>
                {pack.description && (
                    <p className="mt-1 text-sm text-[var(--ink-muted)]">{pack.description}</p>
                )}
                <p className="mt-2 text-xs text-[var(--ink-faint)]">
                    {pack.source === 'imported' ? '已导入 Codex Pets 素材' : '内置样式'}
                </p>
            </div>
        </button>
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
    const dropZoneRef = useRef<HTMLDivElement | null>(null);
    const refreshSeqRef = useRef(0);
    const mountedRef = useRef(true);

    const selectedPetId = config.floatingBallPetId ?? 'mino-default';
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
            notifyBallAppearanceChanged();
            track('floating_ball_pet_select', { pet_id: pack.id, source: pack.source ?? 'builtin' });
        },
        [updateConfig],
    );

    const setEnabled = useCallback(
        async (enabled: boolean) => {
            if (enabled && isTauriEnvironment()) {
                const capabilities = await invoke<FbCapabilities>('cmd_fb_capabilities');
                if (!capabilities.supported) {
                    toast.error('当前系统暂不支持桌面宠物');
                    return;
                }
                try {
                    await invoke('cmd_fb_enable');
                } catch (err) {
                    toast.error(`启用桌面宠物失败：${err instanceof Error ? err.message : String(err)}`);
                    return;
                }
            }

            await updateConfig({ floatingBallEnabled: enabled });
            track('floating_ball_toggle', { gate: false, enabled });

            if (!enabled && isTauriEnvironment()) {
                void invoke('cmd_fb_disable').catch((err) => {
                    console.warn('[FloatingBallPetSettings] toggle floating ball failed:', err);
                });
            }
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
            <div className="mb-8">
                <h2 className="text-xl font-semibold text-[var(--ink)]">桌面宠物</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--ink-muted)]">
                    用 Codex Pets 兼容资源替换悬浮球视觉，让 Mino 在桌面边缘用不同动作反馈空闲、运行、等待确认和完成等状态。
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

                    <div className="grid gap-3 md:grid-cols-3">
                        {BUILTIN_PET_PACKS.map((pack) => (
                            <PetStyleCard
                                key={pack.id}
                                pack={pack}
                                active={(config.floatingBallAppearance ?? 'pet') === 'pet' && selectedPetId === pack.id}
                                onSelect={() => void selectPetPack(pack)}
                            />
                        ))}
                    </div>

                    {installedPacks.length > 0 && (
                        <div className="mt-4 grid gap-3 md:grid-cols-3">
                            {installedPacks.map((pack) => (
                                <PetStyleCard
                                    key={pack.id}
                                    pack={pack}
                                    active={(config.floatingBallAppearance ?? 'pet') === 'pet' && selectedPetId === pack.id}
                                    onSelect={() => void selectPetPack(pack)}
                                />
                            ))}
                        </div>
                    )}

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
