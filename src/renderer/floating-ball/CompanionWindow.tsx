/**
 * Companion chat window (PRD 0.2.35) — the transparent NSPanel that holds the
 * Mino desktop-channel conversation. Visual spec: the sign-off'd playground
 * (specs/playground/0.2.35_floating_ball.html) — one glass sheet, no chrome
 * until hover, conversation + hairline input area.
 *
 * Mode model（透明度 = 投入度）:
 *   hidden → peek（hover：半透明，纯视觉，焦点纹丝不动）
 *          → pin （点击/球点击：变实 + 拿键盘焦点；窗口失焦/Esc/×/再点球 → hidden）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { listenWithCleanup } from '@/utils/tauriListen';
import Markdown from '@/components/Markdown';
import { track } from '@/analytics';
import { isImeComposingEvent, resolveEnterKeyAction } from '@/utils/chatSendKey';
import { useFloatingSession, type FbActivity, type FbMsg } from './useFloatingSession';

import './fb.css';

type FbMode = 'hidden' | 'peek' | 'pin';

interface FbCtx {
    appName?: string | null;
    windowTitle?: string | null;
    selection?: string | null;
}

const WIN_W = 440;
const WIN_H_KEY = 'fb-win-h';
const HIDE_GRACE_MS = 280;

function loadWinH(): number {
    const saved = parseInt(localStorage.getItem(WIN_H_KEY) ?? '', 10);
    return Number.isFinite(saved) && saved >= 360 ? Math.min(saved, 1200) : 660;
}

/** cameo 式单行活动条：状态点 + 名称 + 灰色 detail（思考带活秒表）。 */
function ActivityRow({ label, detail, running }: { label: string; detail?: string; running: boolean }) {
    return (
        <div className={`fbw-act${running ? ' running' : ''}`}>
            <span className="dot" />
            <span className="label">{running && label === '思考' ? '思考中' : label}</span>
            {detail && <span className="detail">{detail}</span>}
        </div>
    );
}

function activityDetail(a: FbActivity, _tick: number): string | undefined {
    const ms = a.durationMs ?? (a.running ? Date.now() - a.startedAt : 0);
    const secs = Math.round(ms / 1000);
    return secs >= 1 ? `${secs}s` : undefined;
}

export default function CompanionWindow() {
    // `mode` drives rendering; `modeRef` mirrors it for event handlers and the
    // session hook. The ref is written ONLY inside applyMode (every mode
    // transition funnels through it) — never during render (react-hooks/refs).
    const [mode, setMode] = useState<FbMode>('hidden');
    const modeRef = useRef<FbMode>('hidden');

    const session = useFloatingSession(modeRef);
    // ⚠️ 稳定性纪律（review critical）：`session` 是每渲染新对象——监听 effect
    // 的依赖链只能挂这些 useCallback 稳定函数，否则流式期间每个 chunk 都会
    // 重订阅 Tauri listener，abort↔listen 的异步空窗会静默吞掉跨窗口事件。
    const { markRead, rotateIfStale, send, suspend, resume } = session;

    const [quote, setQuote] = useState<string | null>(null);
    const [shot, setShot] = useState<string | null>(null); // data URL
    const [who, setWho] = useState<string>('Mino');
    const [input, setInput] = useState('');
    const [axNeeded, setAxNeeded] = useState(false);

    const convoRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mouseInsideRef = useRef(false);
    // 活动行秒表（仅有 running 活动时跳动）
    const [nowTick, setNowTick] = useState(0);
    const hasRunningActivity = session.activities.some((a) => a.running);
    useEffect(() => {
        if (!hasRunningActivity) return;
        const id = setInterval(() => setNowTick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [hasRunningActivity]);
    // Eager-captured situation（最前台 app/标题）— 发送时随 user 消息走（D4）。
    const lastCtxRef = useRef<FbCtx | null>(null);

    // ── mode → 通知球（球用它决定点击语义）＋ pin 时清未读 ──
    const applyMode = useCallback(
        (next: FbMode) => {
            setMode(next);
            modeRef.current = next;
            void invoke('cmd_fb_relay', {
                target: 'ball',
                event: 'fb:companion-mode',
                payload: { mode: next },
            }).catch(() => undefined);
            if (next === 'pin') markRead();
        },
        [markRead],
    );

    const hideSelf = useCallback(() => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
        applyMode('hidden');
        void invoke('cmd_fb_hide_companion');
    }, [applyMode]);

    const scheduleHideIfPeek = useCallback(() => {
        if (modeRef.current !== 'peek') return;
        if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
        hideTimerRef.current = setTimeout(() => {
            if (modeRef.current === 'peek' && !mouseInsideRef.current) {
                hideSelf();
            }
        }, HIDE_GRACE_MS);
    }, [hideSelf]);

    const applySummonCtx = useCallback(
        async (ctx: FbCtx | null | undefined) => {
            lastCtxRef.current = ctx ?? null;
            if (ctx?.appName) {
                setWho(`Mino · 正在看 ${ctx.appName}${ctx.windowTitle ? ` — ${ctx.windowTitle}` : ''}`);
            } else {
                setWho('Mino');
            }
            if (ctx?.selection) {
                setQuote(ctx.selection);
                setAxNeeded(false);
            } else {
                // 没有选区且 AX 未授权 → 第一次"想给引用"的时机就是引导时机（PRD §8）。
                try {
                    const trusted = await invoke<boolean>('cmd_fb_ax_status', { prompt: false });
                    setAxNeeded(!trusted);
                } catch {
                    setAxNeeded(false);
                }
            }
        },
        [],
    );

    const summonPinned = useCallback(
        async (ctx: FbCtx | null | undefined) => {
            applyMode('pin');
            await applySummonCtx(ctx);
            track('floating_ball_summon', { kind: 'pin' });
            requestAnimationFrame(() => inputRef.current?.focus());
            // 唤起时机做按天轮换评估（boot-only 检查跨午夜长跑会失效）。
            void rotateIfStale();
        },
        [applyMode, applySummonCtx, rotateIfStale],
    );

    // ── 球 → 伴侣窗事件 ──
    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup(
            'fb:ball-enter',
            () => {
                if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                if (modeRef.current === 'hidden') applyMode('peek');
            },
            ac.signal,
        );
        void listenWithCleanup('fb:ball-leave', () => scheduleHideIfPeek(), ac.signal);
        // summon 拆两段（性能：窗口显示不等 AX capture）：fb:summon = 快相位
        // （立即 pin + 聚焦），fb:summon-ctx = 处境到位后补引用条/标题行。
        void listenWithCleanup(
            'fb:summon',
            () => {
                void summonPinned(null);
            },
            ac.signal,
        );
        void listenWithCleanup<{ ctx?: FbCtx }>(
            'fb:summon-ctx',
            (e) => {
                void applySummonCtx(e.payload?.ctx ?? null);
            },
            ac.signal,
        );
        void listenWithCleanup('fb:close-request', () => hideSelf(), ac.signal);
        void listenWithCleanup('fb:force-hidden', () => applyMode('hidden'), ac.signal);
        // 生命周期（review C2）：关闭悬浮球 → 断 SSE + 释放 sidecar owner；
        // 重新开启 → 重新 ensure + 连接。
        void listenWithCleanup<{ active?: boolean }>(
            'fb:lifecycle',
            (e) => {
                if (e.payload?.active === false) void suspend();
                else void resume();
            },
            ac.signal,
        );
        // 原生 hover 信号（修 hover 失灵）：app 非激活时 WKWebView 收不到
        // mouseMoved，DOM mouseenter/leave 不可靠——NSTrackingArea 的进出
        // 事件经 Rust 转发到这里，驱动 peek 的 grace 计时。
        void listenWithCleanup<{ inside?: boolean }>(
            'fb:native-hover',
            (e) => {
                if (e.payload?.inside) {
                    mouseInsideRef.current = true;
                    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
                } else {
                    mouseInsideRef.current = false;
                    scheduleHideIfPeek();
                }
            },
            ac.signal,
        );
        // 握手（review W1）：监听就绪后告知球——球在此之前的 summon 会暂存并重放，
        // 否则 enable 后立即点击的 fb:summon 会落在监听注册前被静默丢弃。
        void invoke('cmd_fb_relay', { target: 'ball', event: 'fb:companion-ready', payload: {} }).catch(
            () => undefined,
        );
        return () => ac.abort();
    }, [applyMode, applySummonCtx, scheduleHideIfPeek, summonPinned, hideSelf, suspend, resume]);

    // ── 窗口失焦（pin 态用户点了别处）→ 收起；Esc → 收起 ──
    useEffect(() => {
        const onBlur = () => {
            if (modeRef.current === 'pin') hideSelf();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') hideSelf();
        };
        window.addEventListener('blur', onBlur);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('keydown', onKey);
        };
    }, [hideSelf]);

    // ── peek 态点击任意处 → 升格 pin（即时；处境并行抓、到了再补） ──
    const onWinClick = useCallback(() => {
        if (modeRef.current !== 'peek') return;
        void invoke('cmd_fb_pin_companion').catch((err) => {
            console.error('[fb] pin failed:', err);
        });
        void summonPinned(null);
        void (async () => {
            try {
                const ctx = await invoke<FbCtx>('cmd_fb_capture_context');
                await applySummonCtx(ctx);
            } catch {
                // capture 失败不阻断 pin
            }
        })();
    }, [summonPinned, applySummonCtx]);

    // ── 自动滚底 ──
    useEffect(() => {
        const el = convoRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [session.messages, session.streamText, mode]);

    // ── 初始高度（记忆） ──
    useEffect(() => {
        void invoke('cmd_fb_set_companion_size', { width: WIN_W, height: loadWinH() });
    }, []);

    // ── 发送 ──（埋点在 hook 的 send 内、入队成功后才打）
    const doSend = useCallback(async () => {
        const text = input.trim();
        if (!text || session.busy || !session.ready) return;
        setInput('');
        const q = quote;
        const s = shot;
        setQuote(null);
        setShot(null);
        const ctx = lastCtxRef.current;
        await send(text, {
            quote: q,
            screenshotDataUrl: s,
            appName: ctx?.appName ?? null,
            windowTitle: ctx?.windowTitle ?? null,
        });
    }, [input, quote, shot, session.busy, session.ready, send]);

    // 输入交互与主对话框同源（用户验收裁决：复用，不自创）：
    // chatSendKey 纯函数承担 Enter/换行语义（含 chatSendShortcut 偏好），
    // composition ref + 事件双保险挡 IME 候选提交误发（#123 同款），
    // 组合输入期间不写 textarea.style.height（WebKit 卡顿坑）。
    const isComposingRef = useRef(false);
    const doSendRef = useRef(doSend);
    useEffect(() => {
        doSendRef.current = doSend;
    }, [doSend]);
    const sendShortcutRef = useRef(session.sendShortcut);
    useEffect(() => {
        sendShortcutRef.current = session.sendShortcut;
    }, [session.sendShortcut]);

    const resizeInput = useCallback((el: HTMLTextAreaElement) => {
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
    }, []);

    const onInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key !== 'Enter') return;
        if (isComposingRef.current || isImeComposingEvent(e)) return;
        if (resolveEnterKeyAction(e, sendShortcutRef.current) !== 'send') return;
        e.preventDefault();
        void doSendRef.current();
    }, []);
    const onCompositionStart = useCallback(() => {
        isComposingRef.current = true;
    }, []);
    const onCompositionEnd = useCallback((e: React.CompositionEvent<HTMLTextAreaElement>) => {
        isComposingRef.current = false;
        resizeInput(e.currentTarget);
    }, [resizeInput]);

    // ── 📷 快门（D7：只在点下这一刻发生） ──
    const onShot = useCallback(async () => {
        try {
            const dataUrl = await invoke<string>('cmd_fb_screenshot');
            setShot(dataUrl);
            track('floating_ball_summon', { kind: 'screenshot' });
        } catch (err) {
            console.warn('[fb] screenshot failed:', err);
        }
    }, []);

    // ── 展开进主程序（唤起主窗 → 新 Tab 接上这条会话） ──
    const onExpand = useCallback(() => {
        if (!session.sessionId || !session.workspacePath) return;
        track('floating_ball_expand', {});
        void invoke('cmd_fb_open_main_with_session', {
            sessionId: session.sessionId,
            workspacePath: session.workspacePath,
        });
        hideSelf();
    }, [session.sessionId, session.workspacePath, hideSelf]);

    // ── AX 授权引导 ──
    const onGrantAx = useCallback(async () => {
        try {
            await invoke('cmd_fb_ax_status', { prompt: true });
            setAxNeeded(false);
        } catch {
            // 系统弹窗已出现即可
        }
    }, []);

    // ── 高度调节（顶/底边拖） + 移动（顶部标题栏地带拖） ──
    const bindResize = useCallback((edge: 'top' | 'bottom') => {
        return (e: React.PointerEvent<HTMLDivElement>) => {
            if (modeRef.current !== 'pin') return;
            e.preventDefault();
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            target.classList.add('active');
            let lastY = e.screenY;
            let height = window.innerHeight;
            const onMove = (ev: PointerEvent) => {
                const dy = ev.screenY - lastY;
                lastY = ev.screenY;
                if (edge === 'bottom') {
                    height = Math.max(360, height + dy);
                    void invoke('cmd_fb_set_companion_size', { width: WIN_W, height });
                } else {
                    height = Math.max(360, height - dy);
                    void invoke('cmd_fb_set_companion_size', { width: WIN_W, height });
                    void invoke('cmd_fb_drag_companion', { dx: 0, dy });
                }
            };
            const onUp = (ev: PointerEvent) => {
                target.releasePointerCapture(ev.pointerId);
                target.classList.remove('active');
                target.removeEventListener('pointermove', onMove);
                target.removeEventListener('pointerup', onUp);
                localStorage.setItem(WIN_H_KEY, String(Math.round(height)));
            };
            target.addEventListener('pointermove', onMove);
            target.addEventListener('pointerup', onUp);
        };
    }, []);

    const onMoveDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        if (modeRef.current !== 'pin') return;
        e.preventDefault();
        const target = e.currentTarget;
        target.setPointerCapture(e.pointerId);
        target.classList.add('active');
        let lastX = e.screenX;
        let lastY = e.screenY;
        const onMove = (ev: PointerEvent) => {
            const dx = ev.screenX - lastX;
            const dy = ev.screenY - lastY;
            lastX = ev.screenX;
            lastY = ev.screenY;
            void invoke('cmd_fb_drag_companion', { dx, dy });
        };
        const onUp = (ev: PointerEvent) => {
            target.releasePointerCapture(ev.pointerId);
            target.classList.remove('active');
            target.removeEventListener('pointermove', onMove);
            target.removeEventListener('pointerup', onUp);
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
    }, []);

    const sendReady = input.trim().length > 0 && !session.busy && session.ready;

    return (
        <div
            className={`fbw-win ${mode === 'pin' ? 'pin' : 'peek'}`}
            onClick={onWinClick}
            onMouseEnter={() => {
                mouseInsideRef.current = true;
                if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
            }}
            onMouseLeave={() => {
                mouseInsideRef.current = false;
                scheduleHideIfPeek();
            }}
        >
            {/* chrome：pin 悬停浮现 */}
            <div className="fbw-chrome">
                <span className="who">{who}</span>
                <button onClick={onExpand} title="在 MyAgents 中打开（新 Tab 接上这条会话）">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>
                </button>
                <button onClick={hideSelf} title="关闭（Esc）">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
            </div>

            {/* 会话流 */}
            <div className="fbw-convo" ref={convoRef}>
                {!session.ready && !session.error && (
                    <div className="fbw-divider">正在连接 {session.workspaceName}…</div>
                )}
                {session.error && !session.ready && (
                    <div className="fbw-error">{session.error}</div>
                )}
                {session.messages.map((m: FbMsg) =>
                    m.role === 'user' ? (
                        <div className="fbw-msg user" key={m.id}>
                            <div className="pill">
                                {m.quote && <div className="q">{m.quote}</div>}
                                {m.hasShot && <div className="q">📷 屏幕截图</div>}
                                {m.text}
                            </div>
                        </div>
                    ) : m.role === 'act' ? (
                        <ActivityRow key={m.id} label={m.label ?? ''} detail={m.detail} running={false} />
                    ) : (
                        <div className="fbw-msg ai" key={m.id}>
                            <Markdown>{m.text}</Markdown>
                        </div>
                    ),
                )}
                {/* 本轮进行中的活动行（思考/工具，cameo 式单行密度） */}
                {session.activities.map((a: FbActivity) => (
                    <ActivityRow
                        key={a.id}
                        label={a.label}
                        running={a.running}
                        detail={activityDetail(a, nowTick)}
                    />
                ))}
                {session.streamText !== null && (
                    <div className="fbw-msg ai" key="streaming">
                        <Markdown>{session.streamText}</Markdown>
                        <span className="fbw-caret" />
                    </div>
                )}
                {session.permReq && (
                    <div className="fbw-perm">
                        <div className="p-title">需要你的确认 · {session.permReq.toolName}</div>
                        <div className="p-desc">{session.permReq.input}</div>
                        <div className="p-row">
                            <button className="deny" onClick={() => void session.respondPermission('deny')}>拒绝</button>
                            <button className="allow" onClick={() => void session.respondPermission('allow_once')}>允许</button>
                        </div>
                    </div>
                )}
            </div>

            {/* 兜底状态行：仅在还没有任何可见反馈（无活动行/无流式文本）时出现 */}
            {session.busy && session.activities.length === 0 && session.streamText === null && (
                <div className="fbw-statusline">
                    <span className="fbw-spinner" />
                    <span style={{ flex: 1 }}>Mino 正在处理…</span>
                </div>
            )}
            {session.error && session.ready && (
                <div className="fbw-error">{session.error}</div>
            )}

            {/* AX 授权引导（第一次想给引用时） */}
            {mode === 'pin' && axNeeded && (
                <div className="fbw-ax">
                    授权「辅助功能」后，唤起时能自动带上你选中的文字（一次授权，长期有效）。
                    <br />
                    <button onClick={() => void onGrantAx()}>去授权</button>
                </div>
            )}

            {/* 输入区 */}
            <div className="fbw-inputarea">
                {quote && (
                    <div className="fbw-quote">
                        <span className="rule" />
                        <span className="q-text">{quote}</span>
                        <button className="q-x" onClick={() => setQuote(null)} title="去掉引用">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                    </div>
                )}
                {shot && (
                    <div className="fbw-quote shot">
                        <span className="rule" />
                        <span className="q-text">屏幕截图 · 刚刚</span>
                        <button className="q-x" onClick={() => setShot(null)} title="去掉截图">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                        </button>
                    </div>
                )}
                <div className="fbw-inputrow">
                    <textarea
                        ref={inputRef}
                        rows={1}
                        value={input}
                        placeholder="问问 Mino，或者派个活…"
                        onChange={(e) => {
                            setInput(e.target.value);
                            // IME 组合期间不写 style（#123：触发 WebKit 候选窗重排卡顿）
                            if (!isComposingRef.current) resizeInput(e.target);
                        }}
                        onKeyDown={onInputKeyDown}
                        onCompositionStart={onCompositionStart}
                        onCompositionEnd={onCompositionEnd}
                    />
                    <button className="cam" onClick={() => void onShot()} title="附上一张截屏（我授意的快门）">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" /><circle cx="12" cy="13" r="4" /></svg>
                    </button>
                    {/* 与主对话框同语义：运行中 = 停止（方块），否则 = 发送（箭头） */}
                    {session.busy ? (
                        <button className="send stop" onClick={() => void session.stop()} title="停止">
                            <svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
                        </button>
                    ) : (
                        <button className={`send${sendReady ? ' ready' : ''}`} onClick={() => void doSend()} title="发送">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                        </button>
                    )}
                </div>
            </div>

            {/* 高度调节柄 + 移动拖拽区（仅 pin） */}
            <div className="fbw-rz top" onPointerDown={bindResize('top')} title="拖动调节高度" />
            <div className="fbw-rz bottom" onPointerDown={bindResize('bottom')} title="拖动调节高度" />
            <div className="fbw-mv" onPointerDown={onMoveDown} title="拖动移动窗口" />
        </div>
    );
}
