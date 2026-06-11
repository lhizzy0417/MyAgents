/**
 * 设置 → 工具箱 的「CLI 工具」分区（PRD 0.2.36 cli_first_tool_registry）。
 *
 * 数据源 = sidecar Admin API（/api/admin/tool/*，与 `myagents tool` 同一套
 * handler），不直读磁盘。注册入口刻意不在 GUI：工具由对话中的 AI 经
 * tool-creator 创建注册，本分区只承担可见性/管理（可审计性三件套之一）+
 * 空状态的用户引导。视觉以 specs/playgrounds/toolbox_settings_tab.html
 * 定稿版为准。
 */
import { Copy, Loader2, Settings2, SquareTerminal, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CliToolRegistryEntry } from '../../shared/types/cliTools';
import { CLI_TOOL_DESCRIPTION_MAX_CHARS } from '../../shared/types/cliTools';
import { apiPostJson } from '@/api/apiFetch';
import ConfirmDialog from '@/components/ConfirmDialog';
import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useToast } from '@/components/Toast';
import { useCloseLayer } from '@/hooks/useCloseLayer';

type CliToolView = CliToolRegistryEntry & {
    kind: 'api' | 'local';
    missingEnvKeys: string[];
};

interface AdminResponse<T = unknown> {
    success: boolean;
    data?: T;
    error?: string;
    hint?: string;
}

/** 发给 AI 的注册指令（复制时不带占位符，方便用户直接续写路径） */
const REGISTER_PROMPT = '请使用 tool-creator 帮我把这个 CLI 工具添加到 MyAgents 工具箱：';
const EXAMPLE_PROMPTS = [
    '把『合并多个 Markdown 文件』做成一个 CLI 工具，以后直接用',
    '把火山引擎的语音合成 API 封装成一个 CLI 工具',
];

async function postAdmin<T>(route: string, body: Record<string, unknown>): Promise<AdminResponse<T>> {
    return await apiPostJson<AdminResponse<T>>(`/api/admin/tool/${route}`, body);
}

export function CliToolsSection() {
    const toast = useToast();
    const toastRef = useRef(toast);
    toastRef.current = toast;
    const isMountedRef = useRef(true);
    useEffect(() => {
        isMountedRef.current = true;
        return () => { isMountedRef.current = false; };
    }, []);

    const [tools, setTools] = useState<CliToolView[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [detailTool, setDetailTool] = useState<CliToolView | null>(null);
    const [readme, setReadme] = useState<{ loading: boolean; text?: string; error?: string }>({ loading: false });
    const [envDraft, setEnvDraft] = useState<Record<string, string>>({});
    const [envConfigured, setEnvConfigured] = useState<Record<string, string>>({});
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const res = await postAdmin<{ tools: CliToolView[] }>('list', {});
            if (!isMountedRef.current) return;
            if (res.success) setTools(res.data?.tools ?? []);
        } catch {
            // sidecar 未就绪等瞬态错误：保持现状，区头仍可见
        } finally {
            if (isMountedRef.current) setLoaded(true);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);

    // 与兄弟组件（LinkContextMenuProvider / ProcessRow）同一形态：失败如实报错，
    // 不走 deprecated execCommand fallback、不假报成功
    const copyText = useCallback((text: string) => {
        navigator.clipboard.writeText(text).then(
            () => toastRef.current.success('已复制，去对话里粘贴给 AI'),
            () => toastRef.current.error('复制失败，请手动复制'),
        );
    }, []);

    const handleToggle = useCallback(async (tool: CliToolView) => {
        const next = !tool.enabled;
        setTools(prev => prev.map(t => (t.name === tool.name ? { ...t, enabled: next } : t)));
        try {
            const res = await postAdmin(next ? 'enable' : 'disable', { name: tool.name });
            if (!res.success) throw new Error(res.error);
            toastRef.current.success(next ? '已加入 AI 上下文（新会话生效）' : '已从 AI 上下文隐藏（工具仍可手动调用）');
        } catch (e) {
            if (isMountedRef.current) {
                // 函数式回滚基于本次意图取反，不用闭包捕获的 tool.enabled（连续快速点击会捕获到陈旧值）
                setTools(prev => prev.map(t => (t.name === tool.name ? { ...t, enabled: !next } : t)));
            }
            toastRef.current.error(`操作失败：${e instanceof Error ? e.message : String(e)}`);
        }
    }, []);

    // latest-wins：快速 A→B 打开详情时，A 的迟到响应不能写进 B 的弹窗（useRef + reqId）
    const detailReqRef = useRef(0);
    const openDetail = useCallback(async (tool: CliToolView) => {
        const reqId = ++detailReqRef.current;
        setDetailTool(tool);
        setEnvDraft({});
        setEnvConfigured({});
        setReadme({ loading: true });
        const [readmeRes, envRes] = await Promise.allSettled([
            postAdmin<{ readme: string }>('readme', { name: tool.name }),
            postAdmin<{ env: Record<string, string> }>('env', { name: tool.name, action: 'get' }),
        ]);
        if (!isMountedRef.current || detailReqRef.current !== reqId) return;
        if (readmeRes.status === 'fulfilled' && readmeRes.value.success) {
            setReadme({ loading: false, text: readmeRes.value.data?.readme ?? '' });
        } else {
            const msg = readmeRes.status === 'fulfilled' ? readmeRes.value.error : String(readmeRes.reason);
            setReadme({ loading: false, error: msg || '读取失败' });
        }
        if (envRes.status === 'fulfilled' && envRes.value.success) {
            setEnvConfigured(envRes.value.data?.env ?? {});
        }
    }, []);

    const closeDetail = useCallback(() => {
        setDetailTool(null);
        setConfirmDelete(false);
    }, []);

    const handleSaveEnv = useCallback(async () => {
        if (!detailTool) return;
        const filled = Object.fromEntries(Object.entries(envDraft).filter(([, v]) => v.trim().length > 0));
        if (Object.keys(filled).length === 0) {
            closeDetail();
            return;
        }
        setBusy(true);
        try {
            const res = await postAdmin('env', { name: detailTool.name, action: 'set', env: filled });
            if (!res.success) throw new Error(res.error);
            toastRef.current.success('环境变量已保存（工具下次启动生效）');
            closeDetail();
            void refresh();
        } catch (e) {
            toastRef.current.error(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            if (isMountedRef.current) setBusy(false);
        }
    }, [detailTool, envDraft, closeDetail, refresh]);

    const handleDelete = useCallback(async () => {
        if (!detailTool) return;
        setBusy(true);
        try {
            const res = await postAdmin('remove', { name: detailTool.name, purge: false });
            if (!res.success) throw new Error(res.error);
            toastRef.current.success(`已删除工具 ${detailTool.name}`);
            closeDetail();
            void refresh();
        } catch (e) {
            toastRef.current.error(`删除失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            if (isMountedRef.current) setBusy(false);
        }
    }, [detailTool, closeDetail, refresh]);

    return (
        <div className="mt-9 border-t border-[var(--line)] pt-7">
            {/* 分区头（字号按 playground 定稿放大） */}
            <div className="flex items-center gap-2.5">
                <h3 className="flex items-center gap-2 text-[17px] font-semibold text-[var(--ink)]">
                    <SquareTerminal className="h-4 w-4 text-[var(--ink-muted)]" />
                    CLI 工具
                    <span className="rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-xs font-medium text-[var(--ink-muted)]">
                        {tools.length}
                    </span>
                </h3>
            </div>
            <p className="mb-4 mt-1 text-[13px] text-[var(--ink-muted)]">
                由 AI 创建并注册的命令行工具，全部 Runtime 与终端都能直接调用；开关控制是否让 AI 自动发现。
            </p>

            {!loaded ? (
                <div className="flex items-center justify-center rounded-xl border border-dashed border-[var(--line-strong)] py-10">
                    <Loader2 className="h-5 w-5 animate-spin text-[var(--ink-muted)]" />
                </div>
            ) : tools.length === 0 ? (
                /* 空状态：与列表 + 注册指令条互斥，承担"怎么创建"的引导 */
                <div className="rounded-xl border border-dashed border-[var(--line-strong)] px-8 py-12 text-center">
                    <SquareTerminal className="mx-auto mb-3 h-8 w-8 text-[var(--ink-muted)] opacity-50" />
                    <p className="mb-2 text-[17px] font-semibold text-[var(--ink)]">还没有 CLI 工具</p>
                    <p className="mx-auto max-w-xl text-[13px] leading-relaxed text-[var(--ink-muted)]">
                        让 AI 把你常用的需求做成命令行小工具，所有会话随叫随用。试试对 AI 说：
                    </p>
                    <div className="mt-4 flex flex-col items-center gap-2">
                        {EXAMPLE_PROMPTS.map((prompt) => (
                            <div key={prompt} className="flex items-center gap-2">
                                <span className="rounded-lg bg-[var(--paper-inset)]/45 px-3.5 py-1.5 text-[13px] text-[var(--ink)]">
                                    &ldquo;{prompt}&rdquo;
                                </span>
                                <button
                                    onClick={() => void copyText(prompt)}
                                    className="flex shrink-0 items-center gap-1 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
                                >
                                    <Copy className="h-3 w-3" />
                                    复制
                                </button>
                            </div>
                        ))}
                    </div>
                    <p className="mt-6 flex items-center justify-center gap-2 border-t border-dashed border-[var(--line)] pt-4 text-xs text-[var(--ink-muted)]">
                        已有现成的 CLI 工具？发这句话给 AI：「{REGISTER_PROMPT.replace(/：$/, '')}」
                        <button
                            onClick={() => void copyText(REGISTER_PROMPT)}
                            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--line)] bg-[var(--paper-elevated)] px-2 py-1 text-[11px] text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                            <Copy className="h-3 w-3" />
                            复制
                        </button>
                    </p>
                </div>
            ) : (
                <>
                    <div className="grid grid-cols-2 gap-4">
                        {tools.map((tool) => (
                            <div key={tool.name} className="min-w-0 rounded-xl border border-[var(--line)] bg-[var(--paper-elevated)] p-5">
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <SquareTerminal className="h-4 w-4 shrink-0 text-[var(--accent)]/80" />
                                            <h3 className="truncate font-mono font-semibold text-[var(--ink)]" title={tool.name}>{tool.name}</h3>
                                            {tool.version && (
                                                <span className="shrink-0 rounded-full bg-[var(--paper-inset)] px-2 py-0.5 text-[10px] font-medium text-[var(--ink-muted)]">
                                                    v{tool.version}
                                                </span>
                                            )}
                                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tool.kind === 'api'
                                                ? 'border border-[var(--info)]/20 bg-[var(--info-bg)] text-[var(--info)]'
                                                : 'border border-[var(--success)]/20 bg-[var(--success-bg)] text-[var(--success)]'
                                                }`}>
                                                {tool.kind === 'api' ? 'API' : '本地'}
                                            </span>
                                        </div>
                                        {/* 描述行 = manifest.description（触发描述）截断；五件套首句即能力声明，截断后天然可读 */}
                                        <p className="mt-1 truncate text-xs text-[var(--ink-muted)]" title={tool.description}>
                                            {tool.description}
                                        </p>
                                        {tool.missingEnvKeys.length > 0 && (
                                            <p className="mt-1 text-xs text-[var(--warning)]">
                                                ⚠️ 需要配置 API Key
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <button
                                            onClick={() => void openDetail(tool)}
                                            className="rounded-lg p-1.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                                            title="详情"
                                        >
                                            <Settings2 className="h-4 w-4" />
                                        </button>
                                        <button
                                            onClick={() => void handleToggle(tool)}
                                            className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${tool.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--line-strong)]'}`}
                                            title={tool.enabled ? 'AI 可自动发现' : '已隐藏：AI 不会自动发现（仍可手动调用）'}
                                        >
                                            <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-[var(--toggle-thumb)] shadow transition-transform ${tool.enabled ? 'translate-x-5' : 'translate-x-0'}`} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* 注册指令条（有工具时显示，与空状态互斥） */}
                    <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-dashed border-[var(--line-strong)] px-4 py-3">
                        <span className="shrink-0 text-[13px] text-[var(--ink-muted)]">已有现成的 CLI 工具？复制这句话发给对话里的 AI：</span>
                        <span className="min-w-0 flex-1 truncate rounded-lg bg-[var(--paper-inset)]/45 px-3 py-1.5 text-[13px] text-[var(--ink)]">
                            {REGISTER_PROMPT}&lt;工具路径&gt;
                        </span>
                        <button
                            onClick={() => void copyText(REGISTER_PROMPT)}
                            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] px-3 py-1.5 text-xs text-[var(--ink-muted)] transition-colors hover:border-[var(--ink-muted)] hover:text-[var(--ink)]"
                        >
                            <Copy className="h-3.5 w-3.5" />
                            复制
                        </button>
                    </div>
                </>
            )}

            {/* 详情弹窗：触发描述 + env + readme（AI 与人看同一份）+ 删除。
                独立子组件：mount 即注册 useCloseLayer（Cmd+W 红线） */}
            {detailTool && (
                <CliToolDetailModal
                    tool={detailTool}
                    readme={readme}
                    envDraft={envDraft}
                    onEnvDraftChange={setEnvDraft}
                    envConfigured={envConfigured}
                    busy={busy}
                    onClose={closeDetail}
                    onSaveEnv={handleSaveEnv}
                    onRequestDelete={() => setConfirmDelete(true)}
                />
            )}

            {confirmDelete && detailTool && (
                <ConfirmDialog
                    title="删除工具"
                    message={`将从注册表移除「${detailTool.name}」并删除 PATH 上的启动器；工具目录会保留在磁盘上。新会话不再看到该工具。`}
                    confirmText="删除"
                    confirmVariant="danger"
                    loading={busy}
                    onConfirm={() => void handleDelete()}
                    onCancel={() => setConfirmDelete(false)}
                />
            )}
        </div>
    );
}

interface CliToolDetailModalProps {
    tool: CliToolView;
    readme: { loading: boolean; text?: string; error?: string };
    envDraft: Record<string, string>;
    onEnvDraftChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    envConfigured: Record<string, string>;
    busy: boolean;
    onClose: () => void;
    onSaveEnv: () => void;
    onRequestDelete: () => void;
}

/**
 * 工具详情弹窗。独立组件而非内联 JSX：mount 即注册 useCloseLayer（Cmd+W 红线），
 * 与生态内 ConfirmDialog(300)/ContextMenu(50) 同一模式。
 */
function CliToolDetailModal({
    tool, readme, envDraft, onEnvDraftChange, envConfigured, busy,
    onClose, onSaveEnv, onRequestDelete,
}: CliToolDetailModalProps) {
    useCloseLayer(() => { onClose(); return true; }, 50);

    // env 区显示的 key 集合：manifest 声明的 ∪ 已配置的（防御已配置但未声明的残留）
    const envKeysToShow = Array.from(new Set([...(tool.envKeys ?? []), ...Object.keys(envConfigured)]));

    return (
        <OverlayBackdrop className="z-50" onClose={onClose}>
            <div className="mx-4 flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl bg-[var(--paper-elevated)] shadow-xl">
                <div className="flex items-center justify-between border-b border-[var(--line)] px-6 py-4">
                    <div className="min-w-0">
                        <h2 className="truncate font-mono text-base font-semibold text-[var(--ink)]">{tool.name}</h2>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-[var(--ink-muted)]" title={tool.dir}>
                            {tool.dir}{tool.version ? ` · v${tool.version}` : ''} · 注册于 {tool.registeredAt.slice(0, 10)}
                        </p>
                    </div>
                    <button onClick={onClose} className="shrink-0 rounded-lg p-1 text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 space-y-5 overflow-y-auto px-6 py-4">
                    <div>
                        <label className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-[var(--ink)]">
                            触发描述（注入 AI 上下文的部分）
                            <span className="text-[11px] font-normal text-[var(--ink-muted)]">
                                {tool.description.length} / {CLI_TOOL_DESCRIPTION_MAX_CHARS}
                            </span>
                        </label>
                        <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-inset)]/45 px-3 py-2.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                            {tool.description}
                        </div>
                    </div>

                    {envKeysToShow.length > 0 && (
                        <div>
                            <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">环境变量</label>
                            <div className="space-y-2">
                                {envKeysToShow.map((key) => (
                                    <div key={key} className="flex items-center gap-2">
                                        <span className="w-1/3 truncate font-mono text-xs text-[var(--ink)]" title={key}>{key}</span>
                                        <input
                                            type="text"
                                            value={envDraft[key] ?? ''}
                                            onChange={(e) => onEnvDraftChange(prev => ({ ...prev, [key]: e.target.value }))}
                                            placeholder={envConfigured[key] ? envConfigured[key] : '未配置'}
                                            className="min-w-0 flex-1 rounded-lg border border-[var(--line)] bg-[var(--paper)] px-2.5 py-1.5 font-mono text-xs text-[var(--ink)] placeholder:text-[var(--ink-muted)]/60 focus:border-[var(--accent)] focus:outline-none"
                                        />
                                    </div>
                                ))}
                            </div>
                            <p className="mt-1.5 text-[11px] text-[var(--ink-muted)]">
                                未配置时工具会以退出码 3 提示 AI 引导你补齐，不会静默失败
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-[var(--ink)]">
                            使用文档（来自 <span className="font-mono">{tool.name} readme</span>，AI 与你看到同一份）
                        </label>
                        {readme.loading ? (
                            <div className="flex items-center justify-center rounded-lg border border-[var(--line)] py-8">
                                <Loader2 className="h-4 w-4 animate-spin text-[var(--ink-muted)]" />
                            </div>
                        ) : readme.error ? (
                            <div className="rounded-lg border border-[var(--line)] px-3 py-2.5 text-xs text-[var(--warning)]">
                                读取失败：{readme.error}
                            </div>
                        ) : (
                            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-[var(--line)] px-4 py-3 text-xs leading-relaxed text-[var(--ink-muted)]">
                                {readme.text}
                            </pre>
                        )}
                    </div>
                </div>

                <div className="flex items-center justify-between border-t border-[var(--line)] px-6 py-4">
                    <button
                        onClick={onRequestDelete}
                        disabled={busy}
                        className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-[var(--error)] transition-colors hover:bg-[var(--error-subtle)] disabled:opacity-50"
                    >
                        <Trash2 className="h-4 w-4" />
                        删除工具
                    </button>
                    <div className="flex items-center gap-2">
                        <button
                            onClick={onClose}
                            className="rounded-lg px-4 py-2 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
                        >
                            关闭
                        </button>
                        {envKeysToShow.length > 0 && (
                            <button
                                onClick={onSaveEnv}
                                disabled={busy}
                                className="rounded-lg bg-[var(--button-primary-bg)] px-4 py-2 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)] disabled:opacity-50"
                            >
                                保存
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </OverlayBackdrop>
    );
}
