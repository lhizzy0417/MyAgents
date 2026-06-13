/**
 * Desktop-channel session brain for the floating ball companion (PRD 0.2.35).
 *
 * The companion is a "mini Tab": it reuses the whole session-sidecar pipeline
 * (ensure → Rust proxy HTTP → SSE) with a channel identity layered on top —
 * a persistent, config-stored session id routed to the Mino (default) work-
 * space, rotated daily (PRD §6.2: rotation over compaction; cross-session
 * continuity is carried by Mino's memory system, not by session history).
 *
 * Node server side needed ZERO changes: /chat/send + chat:* SSE + GET
 * /sessions/:id are the exact surfaces a Tab uses.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { createSseConnection, type SseConnection } from '@/api/SseConnection';
import { ensureSessionSidecar, getSessionPort, proxyFetch, releaseSessionSidecar, startBackgroundCompletion } from '@/api/tauriClient';
import { createSession } from '@/api/sessionClient';
import { initAnalytics, setAnalyticsContext, track } from '@/analytics';
import { loadAppConfig, atomicModifyConfig } from '@/config/services/appConfigService';
import { loadProjects } from '@/config/services/projectService';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { localDate } from '../../shared/logTime';
import type { AskUserQuestionRequest } from '../../shared/types/askUserQuestion';
import type { ExitPlanModeRequest } from '../../shared/types/planMode';
import { resolveBoundWorkspace, type FbProject } from './workspaceBinding';

export interface FbMsg {
    id: string;
    role: 'user' | 'ai' | 'act';
    text: string;
    quote?: string;
    hasShot?: boolean;
    /** role==='act'：一行轻量活动（思考/工具），cameo 式密度。 */
    label?: string;
    detail?: string;
}

/** Live activity row during a turn（思考/工具调用的单行展示）。 */
export interface FbActivity {
    id: string;
    kind: 'thinking' | 'tool';
    label: string;
    running: boolean;
    startedAt: number;
    durationMs?: number;
}

export interface FbPermReq {
    requestId: string;
    toolName: string;
    input: string;
}

export interface FbSendOpts {
    quote?: string | null;
    screenshotDataUrl?: string | null;
    /** Eager-captured situation（最前台 app / 窗口标题）— D4：进 user 消息。 */
    appName?: string | null;
    windowTitle?: string | null;
}

const OWNER_ID = 'floating-ball';
const HISTORY_LIMIT = 50;

/** Best-effort text extraction from SessionMessage.content (JSON blocks or plain). */
export function extractMessageText(content: string): string {
    if (!content) return '';
    const trimmed = content.trim();
    if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return content;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
            return parsed
                .map((block) => {
                    if (block && typeof block === 'object') {
                        const b = block as { type?: string; text?: string };
                        if (typeof b.text === 'string') return b.text;
                    }
                    return '';
                })
                .filter(Boolean)
                .join('\n\n');
        }
        if (parsed && typeof parsed === 'object') {
            const obj = parsed as { text?: string; content?: string };
            if (typeof obj.text === 'string') return obj.text;
            if (typeof obj.content === 'string') return obj.content;
        }
    } catch {
        // Not JSON — render as-is.
    }
    return content;
}

/**
 * Parse the `GET /sessions/:id` response into companion messages.
 * Response shape is `{ success, session: { messages: SessionMessage[] } }`
 * (src/server/index.ts — the same payload TabProvider reads via
 * `response.session.messages`); reading top-level `.messages` was the
 * review-caught fabrication that left history backfill永远为空.
 */
export function parseSessionHistory(payload: unknown, limit: number): FbMsg[] {
    const session = (payload as { session?: { messages?: unknown } } | null)?.session;
    const raw = Array.isArray(session?.messages)
        ? (session.messages as Array<{ id?: string; role?: string; content?: string }>)
        : [];
    return raw
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-limit)
        .map<FbMsg>((m, i) => ({
            id: m.id ?? `h-${i}`,
            role: m.role === 'user' ? 'user' : 'ai',
            text: extractMessageText(m.content ?? ''),
        }))
        .filter((m) => m.text.trim().length > 0);
}

async function sessionBaseUrl(sessionId: string): Promise<string | null> {
    const port = await getSessionPort(sessionId);
    return port === null ? null : `http://127.0.0.1:${port}`;
}

/**
 * 断言一次 respond POST 真的被后端接受（cross-review C3）。respond 端点对未知 /
 * 过期 / 已轮换的 requestId 会回 **HTTP 200 `{success:false}`**（agent-session 的
 * handleXxxResponse 返回 false），只查 `resp.ok` 会把它当成功清掉卡片 → 后端 pending
 * 仍永久挂起、用户无从重试。这里要求 `success===true` 才算成功，否则抛错让卡片留着。
 */
async function assertRespondSucceeded(resp: Response): Promise<void> {
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = (await resp.json().catch(() => ({}))) as { success?: boolean; error?: string };
    if (body.success !== true) {
        throw new Error(body.error || '后端未确认（请求可能已过期）');
    }
}

export function useFloatingSession(modeRef: React.MutableRefObject<'hidden' | 'peek' | 'pin'>) {
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [workspacePath, setWorkspacePath] = useState<string | null>(null);
    const [workspaceName, setWorkspaceName] = useState<string>('Mino');
    const [messages, setMessages] = useState<FbMsg[]>([]);
    const [streamText, setStreamText] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [permReq, setPermReq] = useState<FbPermReq | null>(null);
    // 交互表单（D13）：用户提问 / 方案审核。与 permReq 并列驱动「等我」球态。
    const [askReq, setAskReq] = useState<AskUserQuestionRequest | null>(null);
    const [planReq, setPlanReq] = useState<ExitPlanModeRequest | null>(null);
    // 本 session 的有效权限模式（D14：创建时种最宽松、之后跟随活状态）。
    // 发送时随消息走（不再硬编码 fullAgency）；chat:permission-mode-changed /
    // 展开 Tab 改 / resume 读快照 三处更新。
    const [permissionMode, setPermissionMode] = useState<string>('fullAgency');
    // 设置面板（D17）：可绑定工作区列表 + 当前覆盖（null=跟随默认）。
    const [projects, setProjects] = useState<FbProject[]>([]);
    const [workspaceOverride, setWorkspaceOverride] = useState<string | null>(null);
    const [unread, setUnread] = useState(0);
    const [activities, setActivities] = useState<FbActivity[]>([]);
    const [sendShortcut, setSendShortcut] = useState<'enter' | 'modEnter'>('enter');
    const activitiesRef = useRef<FbActivity[]>([]);
    useEffect(() => {
        activitiesRef.current = activities;
    }, [activities]);

    const sessionIdRef = useRef<string | null>(null);
    const sseRef = useRef<SseConnection | null>(null);
    const streamRef = useRef<string | null>(null);
    const bootedRef = useRef(false);
    const busyRef = useRef(false);
    useEffect(() => {
        busyRef.current = busy;
    }, [busy]);
    // send 是 []-deps 的稳定 useCallback，权限模式经 ref 读最新（避免 stale 闭包）。
    const permissionModeRef = useRef(permissionMode);
    useEffect(() => {
        permissionModeRef.current = permissionMode;
    }, [permissionMode]);
    // 旧会话是否卡在"等我"的表单上——轮换时据此决定是否中止旧轮（见 rotateTo）。
    // 用 ref 让 rotateTo 不必把这三个 state 纳入依赖（否则会 churn 整条轮换链）。
    const pendingFormRef = useRef(false);
    useEffect(() => {
        pendingFormRef.current = !!(permReq || askReq || planReq);
    }, [permReq, askReq, planReq]);
    const sessionDateRef = useRef<string | null>(null);
    const workspaceRef = useRef<{ path: string } | null>(null);
    // SSE handler 里要触发轮换（会话失效自愈），但 rotateTo 声明在其后——
    // 经 ref 解耦（effect 同步，见 rotateTo 定义处）。
    const rotateToRef = useRef<(today: string, ws: { path: string; name?: string }) => Promise<void>>(
        async () => undefined,
    );
    // Gate-aware runtime for analytics: with multiAgentRuntime off (default)
    // every session is builtin by construction; with the gate on the actual
    // runtime depends on Mino's agent config which the companion deliberately
    // does not resolve (dev-notes cut #2) → honest 'unknown' bucket.
    const analyticsRuntimeRef = useRef<'builtin' | 'unknown'>('builtin');

    // ── ball state push（球状态 = 本 hook 的派生态，经 Rust 转发） ──
    // 「等我 / blocked」= 任意 pending 交互表单（权限 / 提问 / 方案审核）。这让
    // §3.4 的核心「等我」态真正活起来——此前只看 permReq，而 fullAgency 下它几乎
    // 不来、真正会来的 ask-user-question 又不驱动它（PRD §14.1）。
    useEffect(() => {
        const blocked = permReq || askReq || planReq;
        const state = blocked ? 'blocked' : busy ? 'running' : unread > 0 ? 'done' : 'idle';
        void invoke('cmd_fb_relay', {
            target: 'ball',
            event: 'fb:state',
            payload: { state, count: unread },
        }).catch(() => undefined);
    }, [permReq, askReq, planReq, busy, unread]);

    const finalizeStream = useCallback(() => {
        const text = streamRef.current;
        streamRef.current = null;
        setStreamText(null);
        // 把本轮的活动行（思考/工具）按流序折进历史，再接正文（cameo 式：
        // 每行一个轻量条目，永久保留在消息流里）。
        const acts = activitiesRef.current;
        const actMsgs: FbMsg[] = acts.map((a) => {
            const ms = a.durationMs ?? (a.running ? Date.now() - a.startedAt : 0);
            return {
                id: `act-${a.id}`,
                role: 'act' as const,
                text: '',
                label: a.label,
                detail: ms >= 1000 ? `${Math.round(ms / 1000)}s` : undefined,
            };
        });
        setActivities([]);
        setMessages((prev) => {
            const next = [...prev, ...actMsgs];
            if (text && text.trim()) {
                next.push({ id: `ai-${Date.now()}`, role: 'ai', text });
            }
            return next;
        });
    }, []);

    /** 结束所有仍在 running 的活动行（拿到落点时间）。 */
    const settleActivities = useCallback((predicate?: (a: FbActivity) => boolean) => {
        setActivities((prev) =>
            prev.map((a) =>
                a.running && (!predicate || predicate(a))
                    ? { ...a, running: false, durationMs: Date.now() - a.startedAt }
                    : a,
            ),
        );
    }, []);

    const handleSseEvent = useCallback(
        (eventName: string, data: unknown) => {
            switch (eventName) {
                case 'chat:message-chunk': {
                    const chunk = typeof data === 'string' ? data : '';
                    if (!chunk) break;
                    streamRef.current = (streamRef.current ?? '') + chunk;
                    setStreamText(streamRef.current);
                    setBusy(true);
                    // 正文开始 → 思考行落定（工具行等各自的 result 事件）。
                    settleActivities((a) => a.kind === 'thinking');
                    break;
                }
                case 'chat:thinking-start': {
                    setBusy(true);
                    setActivities((prev) => {
                        if (prev.some((a) => a.kind === 'thinking' && a.running)) return prev;
                        return [
                            ...prev,
                            {
                                id: `th-${Date.now()}`,
                                kind: 'thinking',
                                label: '思考',
                                running: true,
                                startedAt: Date.now(),
                            },
                        ];
                    });
                    break;
                }
                case 'chat:tool-use-start': {
                    const payload = data as { id?: string; name?: string } | null;
                    setBusy(true);
                    settleActivities((a) => a.kind === 'thinking');
                    setActivities((prev) => [
                        ...prev,
                        {
                            id: payload?.id ?? `tool-${Date.now()}`,
                            kind: 'tool',
                            label: payload?.name ?? '工具',
                            running: true,
                            startedAt: Date.now(),
                        },
                    ]);
                    break;
                }
                case 'chat:tool-result-start':
                case 'chat:tool-result-complete': {
                    const payload = data as { id?: string; toolUseId?: string } | null;
                    const target = payload?.id ?? payload?.toolUseId;
                    setActivities((prev) => {
                        // 按 id 落定；无 id 时落定最早一个 running 的工具行。
                        let done = false;
                        return prev.map((a) => {
                            if (!a.running || a.kind !== 'tool') return a;
                            if (target ? a.id === target : !done) {
                                done = true;
                                return { ...a, running: false, durationMs: Date.now() - a.startedAt };
                            }
                            return a;
                        });
                    });
                    break;
                }
                case 'chat:message-complete': {
                    finalizeStream();
                    setBusy(false);
                    // 终态清掉一切 pending 表单（backstop：正常路径下用户回应后已清，
                    // 这里兜住中止 / 异常路径，防陈旧卡片）。
                    setPermReq(null);
                    setAskReq(null);
                    setPlanReq(null);
                    if (modeRef.current !== 'pin') {
                        setUnread((n) => n + 1);
                    }
                    break;
                }
                case 'chat:message-error': {
                    const msg =
                        typeof data === 'string'
                            ? data
                            : data && typeof data === 'object' && 'message' in data
                                ? String((data as { message?: unknown }).message ?? '')
                                : '回复出错了';
                    finalizeStream();
                    setBusy(false);
                    setPermReq(null);
                    setAskReq(null);
                    setPlanReq(null);
                    setError(msg || '回复出错了');
                    break;
                }
                case 'chat:message-stopped': {
                    finalizeStream();
                    setBusy(false);
                    setPermReq(null);
                    setAskReq(null);
                    setPlanReq(null);
                    break;
                }
                case 'chat:status': {
                    const payload = data as { sessionState?: string } | null;
                    if (payload?.sessionState === 'idle') {
                        setBusy(false);
                    } else if (payload?.sessionState === 'running' || payload?.sessionState === 'starting') {
                        setBusy(true);
                    }
                    break;
                }
                case 'permission:request': {
                    const payload = data as FbPermReq | null;
                    if (payload?.requestId) {
                        setPermReq({
                            requestId: payload.requestId,
                            toolName: payload.toolName,
                            input: payload.input || '',
                        });
                    }
                    break;
                }
                case 'chat:agent-error': {
                    // Terminal agent errors（rate limit / auth / SDK is_error）走
                    // 这条而非 message-error——漏接会让"发完就走"的任务静默死掉、
                    // 球退回 idle（review W2）。
                    const msg = typeof data === 'string' ? data : 'Agent 出错了，点 ↗ 去主窗口查看';
                    finalizeStream();
                    setBusy(false);
                    // 会话失效自愈：SDK 在当前工作区找不到这条对话（典型：persisted
                    // sid 的 SDK 数据被清理）。直接轮换新 session，别让用户卡死在
                    // 一条永远发不出去的会话里。
                    if (msg.includes('No conversation found')) {
                        setError('上一条会话已失效，已为你开启新对话');
                        const ws = workspaceRef.current;
                        if (ws) {
                            void rotateToRef.current(localDate(), { path: ws.path });
                        }
                    } else {
                        setError(msg);
                    }
                    break;
                }
                // ── 交互表单（D13）：复用主 Chat 同款事件，渲染主组件 ──
                // 这些是「控制转移工具」，即便 fullAgency 也会触发（agent-session.ts
                // 快速通道排除它们），漏接 = 本轮永久 hang（PRD §14.1）。
                // permission / ask-user-question 对 builtin + external 透明（external-session
                // 桌面 scenario 广播同名事件）；plan 事件目前仅 builtin/CC——codex/gemini
                // 不暴露 ExitPlanMode/EnterPlanMode 工具（external-session.ts 注释为证），故
                // external 会话不触发 plan 卡片，分支留着无害、未来 runtime 支持即自动生效。
                case 'ask-user-question:request': {
                    const payload = data as AskUserQuestionRequest | null;
                    if (payload?.requestId && Array.isArray(payload.questions)) {
                        setAskReq(payload);
                    }
                    break;
                }
                case 'ask-user-question:expired': {
                    const rid = (data as { requestId?: string } | null)?.requestId;
                    setAskReq((cur) => (cur && (!rid || cur.requestId === rid) ? null : cur));
                    break;
                }
                case 'exit-plan-mode:request': {
                    const payload = data as ExitPlanModeRequest | null;
                    if (payload?.requestId) setPlanReq(payload);
                    break;
                }
                case 'exit-plan-mode:expired': {
                    const rid = (data as { requestId?: string } | null)?.requestId;
                    setPlanReq((cur) => (cur && (!rid || cur.requestId === rid) ? null : cur));
                    break;
                }
                case 'enter-plan-mode:request': {
                    // EnterPlanMode 走「自动批准、无卡片」，对齐 TabProvider。批准后真正
                    // 的用户介入点是随后的 ExitPlanMode 审核卡。⚠️ SDK-auto 路径广播
                    // { requestId:'sdk_auto_…', autoApproved:true } 且后端**无** pending
                    // （已自行放行）——此时 POST 会命中 "Unknown request"。故仅对非
                    // autoApproved 的真·pending 才回 approved（TabProvider 同款 gate，
                    // cross-review W1）。
                    const payload = data as { requestId?: string; autoApproved?: boolean } | null;
                    const rid = payload?.requestId;
                    const sid = sessionIdRef.current;
                    if (rid && sid && !payload?.autoApproved) {
                        void (async () => {
                            try {
                                const base = await sessionBaseUrl(sid);
                                if (!base) return;
                                await proxyFetch(`${base}/api/enter-plan-mode/respond`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ requestId: rid, approved: true }),
                                });
                            } catch (err) {
                                console.warn('[fb] enter-plan-mode auto-approve failed:', err);
                            }
                        })();
                    }
                    break;
                }
                case 'enter-plan-mode:expired': {
                    break; // 无 UI，无需清理
                }
                case 'chat:permission-mode-changed': {
                    // 权限模式跟随活状态（D14）：用户在展开 Tab 改、AI 出 plan 恢复基线，
                    // 都经此同步，下次发送即采纳。⚠️ **不镜像 'plan'**（cross-review W2）：
                    // 'plan' 是 server 端 in-turn 瞬态；若镜像进 send-mode，一旦本轮异常
                    // 终止（reject-abort / 中途 error）而没走 ExitPlanMode 恢复，send-mode
                    // 会卡在 'plan'，把发完就走的渠道静默降级成逐步确认。只跟非-plan 基线
                    // → 下一次 idle send 带基线、applySessionConfig 自愈。
                    const mode = (data as { permissionMode?: string } | null)?.permissionMode;
                    if (typeof mode === 'string' && mode && mode !== 'plan') setPermissionMode(mode);
                    break;
                }
                default:
                    break;
            }
        },
        [finalizeStream, settleActivities, modeRef],
    );
    const handleSseEventRef = useRef(handleSseEvent);
    handleSseEventRef.current = handleSseEvent;

    /** Mint a fresh channel session and persist the FULL identity triple
     *  (id, workspace, date). PRD §6.2 rotation + §14 D15 全升格：不再自铸裸
     *  UUID，而是走和 Tab 同一条 `POST /sessions` 路径建一条 **owned snapshot
     *  session**——服务端用 `snapshotForOwnedSession` 从绑定 agent 捕获
     *  runtime/model/provider/MCP，session 自此自包含（解决一期 #1/#2 裁剪）。
     *  创建时把 permissionMode 种成该 runtime 的最宽松档（D14：发完就走）。
     *  Workspace 绑定是 load-bearing：SDK 对话树按工作区落盘，跨工作区 resume
     *  必然 "No conversation found"。 */
    const mintSession = useCallback(async (today: string, workspace: string): Promise<string> => {
        // 种「最宽松权限 per runtime」由服务端在快照构造期原子完成（seedMaxPermission
        // → getMaxPermissionForRuntime），不再创建后 PATCH——避免 PATCH 失败被吞、
        // 本地态与磁盘快照不一致（cross-review）。seed≠override：这只是创建起点，
        // 之后跟随 session 活状态（用户在展开 Tab 改 → 写回快照；AI 进/出 plan →
        // chat:permission-mode-changed）。created.permissionMode 即服务端种好的值。
        const created = await createSession(workspace, undefined, { seedMaxPermission: true });
        const sid = created.id;
        setPermissionMode(created.permissionMode ?? 'fullAgency');
        await atomicModifyConfig((c) => ({
            ...c,
            floatingBallSessionId: sid,
            floatingBallSessionDate: today,
            floatingBallSessionWorkspace: workspace,
        }));
        sessionDateRef.current = today;
        // Provenance anchor (PRD §11.2 / D11): downstream session-scoped events
        // — including the server-side ai_turn_complete — join back to this via
        // session_id, which is how the desktop channel becomes sliceable in
        // analytics without any server change.
        track('session_new', {
            session_id: sid,
            triggered_by: 'floating_ball',
            runtime: analyticsRuntimeRef.current,
            has_initial_message: false,
            agent_hash: null,
        });
        return sid;
    }, []);

    /** Ensure sidecar + (re)connect SSE for `sid`. */
    const connectSession = useCallback(async (sid: string, workspace: string): Promise<void> => {
        // 串台防护（cross-review C2）：必须**先**断开旧 SSE、**再**切 sessionIdRef。
        // 否则在 `await ensureSessionSidecar` 的空窗里，旧 session 的 SSE 若送来
        // permission/ask/plan 事件，handler 会用已切到新 sid 的 ref → 用户的回应
        // POST 到新 sid、旧后端 pending 永久挂起。SSE 连接读的是 sessionIdRef，
        // 断开后再换 ref 即可干净重建。
        sseRef.current?.disconnect();
        sseRef.current = null;
        sessionIdRef.current = sid;
        setSessionId(sid);
        setAnalyticsContext({ sessionId: sid });
        // Ensure = pre-warm：伴侣窗作为长寿 owner 让 sidecar 常驻（唤起即出字
        // 的体感来源，PRD §10「最高效 = 预热」）。
        await ensureSessionSidecar(sid, workspace, 'tab', OWNER_ID);
        // SSE（事件名/payload 与 Tab 完全同构，白名单已覆盖）。
        const sse = createSseConnection('fb', sessionIdRef);
        sse.setEventHandler((eventName, data) => handleSseEventRef.current(eventName, data));
        sseRef.current = sse;
        await sse.connect();
    }, []);

    // ── boot：解析 Mino → session 轮换 → ensure → SSE → 历史 ──
    useEffect(() => {
        if (bootedRef.current) return;
        bootedRef.current = true;
        let cancelled = false;

        (async () => {
            try {
                // fb 窗口不挂 App.tsx，需要自己初始化 analytics（否则 platform/
                // app_version 预载与 flush 监听都不在，事件质量打折）。
                void initAnalytics();

                const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
                analyticsRuntimeRef.current = cfg.multiAgentRuntime ? 'unknown' : 'builtin';
                setSendShortcut(cfg.chatSendShortcut ?? 'enter');
                // 设置面板（D17）：工作区选择器的候选 + 当前绑定覆盖。
                setProjects(projects.map((p) => ({ path: p.path, name: p.name })));
                setWorkspaceOverride(cfg.floatingBallWorkspaceOverride ?? null);

                // 渠道路由（D17）：override（钉死）→ 默认工作区 → /mino → 第一个项目。
                // 默认 override=null 时与 Launcher 一致（跟随主端默认工作区）。
                const boundWs = resolveBoundWorkspace(
                    cfg.floatingBallWorkspaceOverride,
                    cfg.defaultWorkspacePath,
                    projects,
                );
                if (!boundWs) {
                    throw new Error('没有可用的工作区——请先在 MyAgents 中完成初始化');
                }
                workspaceRef.current = { path: boundWs.path };

                // Session 轮换（PRD §6.2）：身份三元组 (id, workspace, date)。
                // 日期翻篇 **或** 绑定工作区变更都轮换——后者是硬约束（SDK 对话
                // 树按工作区落盘，跨工作区 resume 必 "No conversation found"）。
                // 跨 session 的"懂我"由记忆系统承载，不靠 session 连续性。
                const today = localDate();
                let sid = cfg.floatingBallSessionId;
                const rotated =
                    !sid
                    || cfg.floatingBallSessionDate !== today
                    || !cfg.floatingBallSessionWorkspace
                    || !workspacePathsEqual(cfg.floatingBallSessionWorkspace, boundWs.path);
                if (rotated) {
                    sid = await mintSession(today, boundWs.path);
                } else {
                    sessionDateRef.current = cfg.floatingBallSessionDate ?? today;
                }
                if (cancelled || !sid) return;

                setWorkspacePath(boundWs.path);
                setWorkspaceName(boundWs.name || 'Mino');
                await connectSession(sid, boundWs.path);
                if (cancelled) return;

                // 历史回填：REST 单一权威（同 #0608 不变量的精神——这里没有
                // replay 竞态，因为伴侣窗只有这一条加载路径）。轮换出的新
                // session 没历史，跳过。
                if (!rotated) {
                    try {
                        const base = await sessionBaseUrl(sid);
                        if (base) {
                            const resp = await proxyFetch(`${base}/sessions/${sid}`, {});
                            if (resp.ok) {
                                const json = await resp.json();
                                const history = parseSessionHistory(json, HISTORY_LIMIT);
                                if (!cancelled && history.length > 0) {
                                    setMessages(history);
                                }
                                // D14：resume 读快照当前权限模式（用户可能在展开
                                // Tab 改过）。SessionData 携带它（SessionMetadata.
                                // permissionMode）。同 W2 跳过 'plan'（瞬态，不该作为
                                // 渠道基线 send-mode；快照通常本就不会是 'plan'，防御）。
                                const mode = (json as { session?: { permissionMode?: string } })?.session
                                    ?.permissionMode;
                                if (!cancelled && typeof mode === 'string' && mode && mode !== 'plan') {
                                    setPermissionMode(mode);
                                }
                            }
                        }
                    } catch (err) {
                        console.warn('[fb] history load failed (non-fatal):', err);
                    }
                }

                if (!cancelled) {
                    setReady(true);
                    // Lands in unified log via frontendLogger — the smoke-test
                    // signal that the desktop channel booted end-to-end.
                    console.info(`[fb] companion ready · session=${sid} workspace=${boundWs.path} rotated=${rotated}`);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- boot-once; helpers are stable useCallbacks
    }, []);

    /** 轮换到一条全新 session（清空会话区 + ensure 新 sidecar + 重连 SSE），并把
     *  旧 session 的 owner 妥善交接——这是 cross-review C1 的修复：此前 rotateTo
     *  只 ensure 新 sid、从不释放旧 sid 的 'floating-ball' owner，每次轮换（按天 /
     *  换工作区 / 新对话）都把旧 sidecar 留成孤儿、常驻到 app 退出。正确做法是复用
     *  主 Chat 的 owner 交接语义（App.tsx）：
     *    - 旧轮卡在"等我"表单上（出不了结果）→ 先 stop 中止它；
     *    - 真在跑的工具 → startBackgroundCompletion 转后台续命（发完就走，结果落历史）；
     *    - 然后释放旧 tab owner：闲则 sidecar 停（并 drain 残留 pending），忙则由
     *      BackgroundCompletion owner 续命到 turn 完成后自动释放。 */
    const rotateTo = useCallback(
        async (today: string, workspace: { path: string; name?: string }) => {
            const oldSid = sessionIdRef.current;
            const oldHadPendingForm = pendingFormRef.current;
            const sid = await mintSession(today, workspace.path);
            workspaceRef.current = { path: workspace.path };
            setWorkspacePath(workspace.path);
            if (workspace.name) setWorkspaceName(workspace.name);
            setMessages([]);
            setActivities([]);
            streamRef.current = null;
            setStreamText(null);
            setPermReq(null);
            setAskReq(null);
            setPlanReq(null);
            setUnread(0);
            setError(null);
            await connectSession(sid, workspace.path);
            // 旧 session owner 交接（C1）。非致命：失败不阻断新会话已就绪。
            if (oldSid && oldSid !== sid) {
                try {
                    if (oldHadPendingForm) {
                        // 卡在表单上的旧轮永远等不到回应（用户已走）→ 中止它。
                        const base = await sessionBaseUrl(oldSid);
                        if (base) await proxyFetch(`${base}/chat/stop`, { method: 'POST' });
                    }
                    await startBackgroundCompletion(oldSid);
                    await releaseSessionSidecar(oldSid, 'tab', OWNER_ID);
                } catch (err) {
                    console.warn('[fb] old session handover failed (non-fatal):', err);
                }
            }
            console.info(`[fb] session rotated · session=${sid} workspace=${workspace.path}`);
        },
        [mintSession, connectSession],
    );

    useEffect(() => {
        rotateToRef.current = rotateTo;
    }, [rotateTo]);

    /** Summon-time rotation check：每次显式唤起时重新解析默认工作区并评估
     *  三元组（boot-only 检查在"跨午夜长跑"和"运行期间改默认工作区"两种
     *  情形下都会失效）。运行中不打断当轮。 */
    const rotateIfStale = useCallback(async () => {
        if (!ready) return;
        if (busyRef.current) return;
        try {
            const today = localDate();
            const [cfg, projects] = await Promise.all([loadAppConfig(), loadProjects()]);
            // 同步设置面板的候选 + 当前绑定（用户可能在别处改了默认工作区 / 加删项目）。
            setProjects(projects.map((p) => ({ path: p.path, name: p.name })));
            setWorkspaceOverride(cfg.floatingBallWorkspaceOverride ?? null);
            const target = resolveBoundWorkspace(
                cfg.floatingBallWorkspaceOverride,
                cfg.defaultWorkspacePath,
                projects,
            );
            if (!target) return;
            const current = workspaceRef.current;
            const dateStale = sessionDateRef.current !== today;
            const wsStale = !current || !workspacePathsEqual(current.path, target.path);
            if (!dateStale && !wsStale) return;
            await rotateTo(today, { path: target.path, name: target.name });
        } catch (err) {
            console.warn('[fb] summon-time rotation failed:', err);
        }
    }, [ready, rotateTo]);

    /** 设置面板（D17）：切换工作区绑定。override=null 跟随默认；具体路径=钉死。
     *  写盘后重新解析目标——目标变了就铸新 session（绑定即身份的一部分）。 */
    const setWorkspaceBinding = useCallback(
        async (override: string | null) => {
            await atomicModifyConfig((c) => ({ ...c, floatingBallWorkspaceOverride: override }));
            setWorkspaceOverride(override);
            try {
                const [cfg, projs] = await Promise.all([loadAppConfig(), loadProjects()]);
                setProjects(projs.map((p) => ({ path: p.path, name: p.name })));
                const target = resolveBoundWorkspace(override, cfg.defaultWorkspacePath, projs);
                if (!target) return;
                const current = workspaceRef.current;
                if (current && workspacePathsEqual(current.path, target.path)) return; // 已在该工作区
                await rotateTo(localDate(), { path: target.path, name: target.name });
            } catch (err) {
                console.warn('[fb] setWorkspaceBinding failed:', err);
                setError('切换工作区失败，请重试');
            }
        },
        [rotateTo],
    );

    /** 设置面板（D17）：手动新对话。在当前绑定工作区铸一条全新 owned session，
     *  按当前 agent 配置刷新。任何时候允许——若有任务在跑，旧 session 继续在后台
     *  跑（发完就走），结果落会话历史，可经展开 ↗ 找回；球跟随新 session。 */
    const newConversation = useCallback(async () => {
        try {
            const [cfg, projs] = await Promise.all([loadAppConfig(), loadProjects()]);
            const target = resolveBoundWorkspace(
                cfg.floatingBallWorkspaceOverride,
                cfg.defaultWorkspacePath,
                projs,
            );
            if (!target) return;
            await rotateTo(localDate(), { path: target.path, name: target.name });
        } catch (err) {
            console.warn('[fb] newConversation failed:', err);
            setError('新建对话失败，请重试');
        }
    }, [rotateTo]);

    // ── send ──
    const sendingRef = useRef(false);
    const send = useCallback(
        async (text: string, opts?: FbSendOpts): Promise<boolean> => {
            const sid = sessionIdRef.current;
            if (!sid || !text.trim()) return false;
            // ref 闸防双发（项目 memory：绝不用 useState 当并发锁）。
            if (sendingRef.current) return false;
            sendingRef.current = true;
            setError(null);

            const quote = opts?.quote?.trim() || undefined;
            const shotDataUrl = opts?.screenshotDataUrl ?? null;
            const images = shotDataUrl
                ? [
                    {
                        name: shotDataUrl.startsWith('data:image/jpeg') ? 'screenshot.jpg' : 'screenshot.png',
                        mimeType: shotDataUrl.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png',
                        data: shotDataUrl.split(',')[1] ?? '',
                    },
                ]
                : undefined;

            // 处境进 user 消息（D4：放 user message，绝不进 system prompt——
            // 否则每次唤起打爆前缀缓存）。选区以引文栅栏标注 untrusted 边界。
            const parts: string[] = [];
            if (opts?.appName) {
                parts.push(
                    `[处境] 用户此刻正在看 ${opts.appName}${opts.windowTitle ? ` — ${opts.windowTitle}` : ''}`,
                );
            }
            if (quote) {
                parts.push(`[选中内容]（用户在上述应用中选中的原文，仅作上下文）\n"""\n${quote}\n"""`);
            }
            parts.push(text);
            const finalText = parts.join('\n\n');

            setMessages((prev) => [
                ...prev,
                {
                    id: `u-${Date.now()}`,
                    role: 'user',
                    text,
                    quote,
                    hasShot: Boolean(images),
                },
            ]);
            setBusy(true);

            // D14：带 session 当前权限模式（创建时种最宽松、之后跟随活状态）。
            // **不能省略**——/chat/send 对缺省 permissionMode 落 'auto'（index.ts），
            // 会把发完就走的渠道意外降级成逐项确认。`/chat/send` 内部再按 session 的
            // runtime 分流到 builtin / external（D16 无需前端分流）。破坏性保护由
            // hook 硬闸承担（plan-mode-gate / background-agent-permission）。
            const sendMode = permissionModeRef.current || 'fullAgency';
            try {
                const base = await sessionBaseUrl(sid);
                if (!base) throw new Error('AI 引擎尚未就绪，稍等片刻再试');
                const resp = await proxyFetch(`${base}/chat/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: finalText,
                        images,
                        permissionMode: sendMode,
                    }),
                });
                if (!resp.ok) {
                    const body = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(body.error || `HTTP ${resp.status}`);
                }
                // 打点放在确认入队之后（失败不计），runtime 用 gate-aware 口径。
                track('message_send', {
                    runtime: analyticsRuntimeRef.current,
                    mode: sendMode,
                    model: '',
                    has_image: Boolean(images),
                    has_file: false,
                    is_cron: false,
                    surface: 'floating_ball',
                    session_id: sid,
                });
                return true;
            } catch (err) {
                setBusy(false);
                setError(err instanceof Error ? err.message : String(err));
                return false;
            } finally {
                sendingRef.current = false;
            }
        },
        [],
    );

    const respondPermission = useCallback(
        async (decision: 'deny' | 'allow_once' | 'always_allow') => {
            const sid = sessionIdRef.current;
            const req = permReq;
            if (!sid || !req) return;
            try {
                const base = await sessionBaseUrl(sid);
                if (!base) throw new Error('sidecar 不可达');
                const resp = await proxyFetch(`${base}/api/permission/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: req.requestId, decision }),
                });
                // 后端真确认（success===true）后才清卡片——乐观清除 / 只查 resp.ok 会在
                // POST 失败或后端回 {success:false}（过期/已轮换）时让 pending 永久挂起
                // 且无从重试（review W4 + cross-review C3）。
                await assertRespondSucceeded(resp);
                setPermReq(null);
            } catch (err) {
                console.error('[fb] permission respond failed:', err);
                setError('确认发送失败，请重试');
            }
        },
        [permReq],
    );

    /** 回答 ask-user-question（D13）。answers=null 表示用户取消（SDK deny+interrupt）。
     *  与 permission 同纪律：成功后才清卡片（W4，乐观清除会卡死后端 pending）。 */
    const respondAskUserQuestion = useCallback(
        async (answers: Record<string, string> | null) => {
            const sid = sessionIdRef.current;
            const req = askReq;
            if (!sid || !req) return;
            try {
                const base = await sessionBaseUrl(sid);
                if (!base) throw new Error('sidecar 不可达');
                const resp = await proxyFetch(`${base}/api/ask-user-question/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: req.requestId, answers }),
                });
                await assertRespondSucceeded(resp);
                setAskReq(null);
            } catch (err) {
                console.error('[fb] ask-user-question respond failed:', err);
                setError('回答发送失败，请重试');
            }
        },
        [askReq],
    );

    /** 审核方案（D13）。approved=true 批准；false + feedback → AI 同轮修订，
     *  false 无 feedback → 中止本轮。成功后才清卡片（W4）。 */
    const respondExitPlanMode = useCallback(
        async (approved: boolean, feedback?: string) => {
            const sid = sessionIdRef.current;
            const req = planReq;
            if (!sid || !req) return;
            try {
                const base = await sessionBaseUrl(sid);
                if (!base) throw new Error('sidecar 不可达');
                const resp = await proxyFetch(`${base}/api/exit-plan-mode/respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: req.requestId, approved, feedback }),
                });
                await assertRespondSucceeded(resp);
                setPlanReq(null);
            } catch (err) {
                console.error('[fb] exit-plan-mode respond failed:', err);
                setError('提交失败，请重试');
            }
        },
        [planReq],
    );

    const markRead = useCallback(() => setUnread(0), []);
    const clearError = useCallback(() => setError(null), []);

    /** Stop the in-flight turn（伴侣窗的"停止"控制）。 */
    const stop = useCallback(async () => {
        const sid = sessionIdRef.current;
        if (!sid) return;
        try {
            const base = await sessionBaseUrl(sid);
            if (!base) return;
            await proxyFetch(`${base}/chat/stop`, { method: 'POST' });
        } catch (err) {
            console.warn('[fb] stop failed:', err);
        }
    }, []);

    /** Feature off（cmd_fb_disable）→ 释放资源：断 SSE + 释放 sidecar owner。
     *  没有这步，关掉悬浮球后 Mino sidecar 会常驻到 app 退出（review C2）。 */
    const suspend = useCallback(async () => {
        const sid = sessionIdRef.current;
        sseRef.current?.disconnect();
        sseRef.current = null;
        if (sid) {
            try {
                await releaseSessionSidecar(sid, 'tab', OWNER_ID);
            } catch (err) {
                console.warn('[fb] release sidecar failed:', err);
            }
        }
        setReady(false);
        setBusy(false);
        setPermReq(null);
        setAskReq(null);
        setPlanReq(null);
        console.info('[fb] companion suspended (owner released)');
    }, []);

    /** Re-enable → 重新 ensure + SSE（沿用当前 session id，历史已在内存）。 */
    const resume = useCallback(async () => {
        const sid = sessionIdRef.current;
        const workspace = workspaceRef.current;
        if (!sid || !workspace || sseRef.current) return;
        try {
            await connectSession(sid, workspace.path);
            setReady(true);
            console.info('[fb] companion resumed');
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [connectSession]);

    return {
        ready,
        error,
        clearError,
        sessionId,
        workspacePath,
        workspaceName,
        messages,
        streamText,
        busy,
        permReq,
        askReq,
        planReq,
        permissionMode,
        projects,
        workspaceOverride,
        unread,
        activities,
        sendShortcut,
        send,
        stop,
        respondPermission,
        respondAskUserQuestion,
        respondExitPlanMode,
        setWorkspaceBinding,
        newConversation,
        markRead,
        rotateIfStale,
        suspend,
        resume,
    };
}
