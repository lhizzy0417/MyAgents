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
import { ensureSessionSidecar, getSessionPort, proxyFetch, releaseSessionSidecar } from '@/api/tauriClient';
import { initAnalytics, setAnalyticsContext, track } from '@/analytics';
import { loadAppConfig, atomicModifyConfig } from '@/config/services/appConfigService';
import { loadProjects } from '@/config/services/projectService';
import { workspacePathsEqual } from '../../shared/workspacePath';
import { localDate } from '../../shared/logTime';

export interface FbMsg {
    id: string;
    role: 'user' | 'ai';
    text: string;
    quote?: string;
    hasShot?: boolean;
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
    const [unread, setUnread] = useState(0);

    const sessionIdRef = useRef<string | null>(null);
    const sseRef = useRef<SseConnection | null>(null);
    const streamRef = useRef<string | null>(null);
    const bootedRef = useRef(false);
    const busyRef = useRef(false);
    useEffect(() => {
        busyRef.current = busy;
    }, [busy]);
    const sessionDateRef = useRef<string | null>(null);
    const workspaceRef = useRef<{ path: string } | null>(null);
    // Gate-aware runtime for analytics: with multiAgentRuntime off (default)
    // every session is builtin by construction; with the gate on the actual
    // runtime depends on Mino's agent config which the companion deliberately
    // does not resolve (dev-notes cut #2) → honest 'unknown' bucket.
    const analyticsRuntimeRef = useRef<'builtin' | 'unknown'>('builtin');

    // ── ball state push（球状态 = 本 hook 的派生态，经 Rust 转发） ──
    useEffect(() => {
        const state = permReq ? 'blocked' : busy ? 'running' : unread > 0 ? 'done' : 'idle';
        void invoke('cmd_fb_relay', {
            target: 'ball',
            event: 'fb:state',
            payload: { state, count: unread },
        }).catch(() => undefined);
    }, [permReq, busy, unread]);

    const finalizeStream = useCallback(() => {
        const text = streamRef.current;
        streamRef.current = null;
        setStreamText(null);
        if (text && text.trim()) {
            setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: 'ai', text }]);
        }
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
                    break;
                }
                case 'chat:message-complete': {
                    finalizeStream();
                    setBusy(false);
                    setPermReq(null);
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
                    setError(msg || '回复出错了');
                    break;
                }
                case 'chat:message-stopped': {
                    finalizeStream();
                    setBusy(false);
                    setPermReq(null);
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
                    setError(msg);
                    break;
                }
                case 'ask-user-question:request': {
                    // 伴侣窗不渲染结构化问题 UI——指引去主窗口处理，避免静默吞掉。
                    setError('Mino 有问题想问你 — 点 ↗ 在主窗口处理');
                    break;
                }
                default:
                    break;
            }
        },
        [finalizeStream, modeRef],
    );
    const handleSseEventRef = useRef(handleSseEvent);
    handleSseEventRef.current = handleSseEvent;

    /** Mint a fresh channel session id and persist it (PRD §6.2 rotation —
     *  same "self-minted UUID + persist" shape as cron rotate_new_session_id). */
    const mintSession = useCallback(async (today: string): Promise<string> => {
        const sid = crypto.randomUUID();
        await atomicModifyConfig((c) => ({
            ...c,
            floatingBallSessionId: sid,
            floatingBallSessionDate: today,
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
        sessionIdRef.current = sid;
        setSessionId(sid);
        setAnalyticsContext({ sessionId: sid });
        // Ensure = pre-warm：伴侣窗作为长寿 owner 让 sidecar 常驻（唤起即出字
        // 的体感来源，PRD §10「最高效 = 预热」）。
        await ensureSessionSidecar(sid, workspace, 'tab', OWNER_ID);
        // SSE（事件名/payload 与 Tab 完全同构，白名单已覆盖）。轮换后端口
        // 变了 → 必须断开重连，让 getServerUrl 按新 session 解析端口。
        sseRef.current?.disconnect();
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

                // 渠道固定路由：Mino（默认工作区）。仅退默认工作区，不再兜底到
                // projects[0]——把渠道静默绑到任意项目工作区违背"项目型不出来"
                // 的定位（review 裁决），宁可报错引导。
                const mino =
                    projects.find((p) => p.systemPresetId === 'mino' || p.templateId === 'mino')
                    ?? projects.find(
                        (p) => cfg.defaultWorkspacePath && workspacePathsEqual(p.path, cfg.defaultWorkspacePath),
                    );
                if (!mino) {
                    throw new Error('未找到 Mino（默认工作区）——请先在 MyAgents 中完成初始化');
                }
                workspaceRef.current = { path: mino.path };

                // Session 轮换（PRD §6.2）：按天轮换；跨 session 的"懂我"由
                // Mino 记忆系统承载，不靠 session 连续性。
                const today = localDate();
                let sid = cfg.floatingBallSessionId;
                const rotated = !sid || cfg.floatingBallSessionDate !== today;
                if (rotated) {
                    sid = await mintSession(today);
                } else {
                    sessionDateRef.current = cfg.floatingBallSessionDate ?? today;
                }
                if (cancelled || !sid) return;

                setWorkspacePath(mino.path);
                setWorkspaceName(mino.name || 'Mino');
                await connectSession(sid, mino.path);
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
                                const history = parseSessionHistory(await resp.json(), HISTORY_LIMIT);
                                if (!cancelled && history.length > 0) {
                                    setMessages(history);
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
                    console.info(`[fb] companion ready · session=${sid} workspace=${mino.path} rotated=${rotated}`);
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

    /** Summon-time rotation check（架构 review 发现 #4）：fb 窗口随 enable 常驻、
     *  永不重载，boot-only 的轮换在跨午夜长跑时失效。每次显式唤起时再评估：
     *  日期翻篇且空闲 → 轮换到新 session（运行中不打断当轮）。 */
    const rotateIfStale = useCallback(async () => {
        const today = localDate();
        if (!ready) return;
        if (busyRef.current) return;
        if (sessionDateRef.current === today) return;
        const workspace = workspaceRef.current;
        if (!workspace) return;
        try {
            const sid = await mintSession(today);
            setMessages([]);
            streamRef.current = null;
            setStreamText(null);
            setPermReq(null);
            setUnread(0);
            await connectSession(sid, workspace.path);
            console.info(`[fb] session rotated at summon · session=${sid}`);
        } catch (err) {
            console.warn('[fb] summon-time rotation failed:', err);
        }
    }, [ready, mintSession, connectSession]);

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

            try {
                const base = await sessionBaseUrl(sid);
                if (!base) throw new Error('AI 引擎尚未就绪，稍等片刻再试');
                const resp = await proxyFetch(`${base}/chat/send`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        text: finalText,
                        images,
                        // PRD §4：自主行动对悬浮球默认开启——"发完就走"要求它自己
                        // 干到底。破坏性保护由 hook 硬闸承担（plan-mode-gate /
                        // background-agent-permission，见 CLAUDE.md #295/#264）。
                        permissionMode: 'fullAgency',
                    }),
                });
                if (!resp.ok) {
                    const body = (await resp.json().catch(() => ({}))) as { error?: string };
                    throw new Error(body.error || `HTTP ${resp.status}`);
                }
                // 打点放在确认入队之后（失败不计），runtime 用 gate-aware 口径。
                track('message_send', {
                    runtime: analyticsRuntimeRef.current,
                    mode: 'fullAgency',
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
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                // 成功后才清卡片——乐观清除会在 POST 失败时让后端 pending
                // permission 永远等不到回应、任务静默卡死（review W4）。
                setPermReq(null);
            } catch (err) {
                console.error('[fb] permission respond failed:', err);
                setError('确认发送失败，请重试');
            }
        },
        [permReq],
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
        unread,
        send,
        stop,
        respondPermission,
        markRead,
        rotateIfStale,
        suspend,
        resume,
    };
}
