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
import OverlayBackdrop from '@/components/OverlayBackdrop';
import CustomSelect from '@/components/CustomSelect';
import { PermissionPrompt } from '@/components/PermissionPrompt';
import { AskUserQuestionPrompt } from '@/components/AskUserQuestionPrompt';
import { ExitPlanModePrompt } from '@/components/ExitPlanModePrompt';
import { track } from '@/analytics';
import { isImeComposingEvent, resolveEnterKeyAction } from '@/utils/chatSendKey';
import { computeDragOrigin } from './fbDrag';
import { isNearBottom } from './convoAutoFollow';
import { useFloatingSession, type FbActivity, type FbMsg } from './useFloatingSession';

import './fb.css';

type FbMode = 'hidden' | 'peek' | 'pin';

interface FbCtx {
    appName?: string | null;
    windowTitle?: string | null;
    selection?: string | null;
}

/** 📷 快门结果（Rust FbScreenshot）：图 + 快门时刻的前台窗口标识。 */
interface FbShot {
    dataUrl: string;
    appName?: string | null;
    windowTitle?: string | null;
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
    const [shot, setShot] = useState<FbShot | null>(null);
    const [shotPreview, setShotPreview] = useState(false); // 缩略图点开的大图
    const [who, setWho] = useState<string>('Mino');
    const [input, setInput] = useState('');
    const [axNeeded, setAxNeeded] = useState(false);
    const [showSettings, setShowSettings] = useState(false); // 设置面板（齿轮，D17）

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
        setShotPreview(false); // 大图预览不跨一次显隐
        setShowSettings(false); // 设置面板不跨一次显隐
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

    // 贴底跟随开关：只有本就贴底才自动滚底（isNearBottom），显式唤起/发送
    // 时强制回贴底。没有它，滚轮上翻阅读会被流式新内容持续拽回底部。
    const stickToBottomRef = useRef(true);

    const summonPinned = useCallback(
        async (ctx: FbCtx | null | undefined) => {
            stickToBottomRef.current = true; // 显式唤起 = 看最新
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

    // ── 窗口失焦（pin 态用户点了别处）→ 收起；Esc → 先关大图预览、再收起 ──
    useEffect(() => {
        const onBlur = () => {
            if (modeRef.current === 'pin') hideSelf();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            // Esc 逐层收口：设置面板 → 大图预览 → 关窗。
            if (showSettings) {
                setShowSettings(false);
                return;
            }
            if (shotPreview) {
                setShotPreview(false);
                return;
            }
            hideSelf();
        };
        window.addEventListener('blur', onBlur);
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('blur', onBlur);
            window.removeEventListener('keydown', onKey);
        };
    }, [hideSelf, shotPreview, showSettings]);

    // ── peek → pin 升格（窗内有效行为 = 激活 + 执行该行为，0612 用户裁决） ──
    // 点击带处境抓取（点击 = "我要说话"）；滚轮只升格不抓处境（滚轮 = "我要
    // 读"，且选区探针的剪贴板兜底——模拟 Cmd+C——不该被一次滚动引爆）。
    const promoteToPin = useCallback(
        async (kind: 'click' | 'wheel') => {
            if (modeRef.current !== 'peek') return;
            applyMode('pin');
            track('floating_ball_summon', { kind: kind === 'click' ? 'pin' : 'wheel' });
            try {
                // 等 make_key_window 真正落地再聚焦：窗口还不是 key window 时
                // focus() 不出光标——这就是"点了面板输入框却没光标"的根因。
                await invoke('cmd_fb_pin_companion');
            } catch (err) {
                console.error('[fb] pin failed:', err);
            }
            // applyMode 已把 modeRef 翻到 pin；重新读一次（窗口可能在 IPC
            // 期间被 Esc 关掉，hidden 时不再聚焦）。as FbMode 抵消 TS 对
            // ref.current 的过期 narrowing（它看不见 applyMode 的写入）。
            if ((modeRef.current as FbMode) === 'pin') inputRef.current?.focus();
            void rotateIfStale();
            if (kind === 'click') {
                void applySummonCtx(null);
                void (async () => {
                    try {
                        const ctx = await invoke<FbCtx>('cmd_fb_capture_context');
                        await applySummonCtx(ctx);
                    } catch {
                        // capture 失败不阻断 pin
                    }
                })();
            }
        },
        [applyMode, applySummonCtx, rotateIfStale],
    );

    // ── 焦点纪律：pin 态输入框光标常驻 ──
    // mousedown 阶段就把焦点按住（retainFocusOnMouseDown 同款 preventDefault，
    // 不给非交互区域转移焦点的机会）；交互件与会话选文区放行。
    // 仅 pin 态生效：peek 态没有任何已聚焦元素可保护，而非 key 窗口的首次
    // 点击（first mouse）在 WebKit 里本就走特殊路径，别去碰它的默认行为。
    const onWinMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        if (modeRef.current !== 'pin') return;
        const target = e.target as Element;
        if (target.closest('textarea, input, button, a, .fbw-convo')) return;
        e.preventDefault();
    }, []);

    // ── key window 收敛兜底 ──
    // 窗口成为 key window 的任何路径（我们的 pin invoke / AppKit 对
    // becomesKeyOnlyIfNeeded panel 的点击自动升 key / 未来新入口），都收敛
    // 到正确终态：peek → 走升格流程；其余 → 光标归位输入框。这是确定性
    // 信号（键盘真的到窗了才 fire），不依赖事件竞速。
    useEffect(() => {
        const onFocus = () => {
            if (modeRef.current === 'peek') {
                void promoteToPin('click');
                return;
            }
            inputRef.current?.focus();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [promoteToPin]);

    const onWinClick = useCallback(
        (e: React.MouseEvent<HTMLDivElement>) => {
            if (modeRef.current === 'peek') {
                void promoteToPin('click');
                return;
            }
            if (modeRef.current !== 'pin') return;
            // pin 态点窗内非交互区域 = 把光标还给输入框（正在选文本除外）。
            const target = e.target as Element;
            if (target.closest('textarea, input, button, a')) return;
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            inputRef.current?.focus();
        },
        [promoteToPin],
    );

    // ── peek 滚轮：直接滚动会话流 + 升格 pin ──
    // peek 下 convo 是 pointer-events:none（整窗单击语义），原生滚动到不了
    // 它——首程 delta 手动喂给会话流，升格后的后续滚轮由原生接管。
    const onWinWheel = useCallback(
        (e: React.WheelEvent<HTMLDivElement>) => {
            if (modeRef.current !== 'peek') return;
            const el = convoRef.current;
            if (el) el.scrollTop += e.deltaY;
            void promoteToPin('wheel');
        },
        [promoteToPin],
    );

    // ── 自动滚底（贴底跟随，唯贴底才跟随） ──
    const onConvoScroll = useCallback(() => {
        const el = convoRef.current;
        if (el) stickToBottomRef.current = isNearBottom(el);
    }, []);
    useEffect(() => {
        const el = convoRef.current;
        if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [session.messages, session.streamText, mode]);

    // ── 初始高度（记忆） ──
    useEffect(() => {
        void invoke('cmd_fb_set_companion_size', { width: WIN_W, height: loadWinH() });
    }, []);

    // ── 发送 ──（埋点在 hook 的 send 内、入队成功后才打）
    const doSend = useCallback(async () => {
        const text = input.trim();
        if (!text || session.busy || !session.ready) return;
        stickToBottomRef.current = true; // 发送 = 跟住回复
        setInput('');
        const q = quote;
        const s = shot;
        setQuote(null);
        setShot(null);
        setShotPreview(false);
        const ctx = lastCtxRef.current;
        await send(text, {
            quote: q,
            screenshotDataUrl: s?.dataUrl ?? null,
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
            const res = await invoke<FbShot>('cmd_fb_screenshot');
            setShot(res);
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
    // 位置一律走绝对落点（与球同源，见 fbDrag.ts），绝不回读 outer_position：
    // 底边拖只改高度（origin 不动，height 是 JS 本地累计、本就无回读）；顶边拖
    // 锚定底边、让顶边跟随光标（newTop=光标−抓取偏移、height=底锚−newTop）；
    // 标题栏自由拖是纯平移（origin=光标−抓取偏移）。
    const bindResize = useCallback((edge: 'top' | 'bottom') => {
        return (e: React.PointerEvent<HTMLDivElement>) => {
            if (modeRef.current !== 'pin') return;
            e.preventDefault();
            const target = e.currentTarget;
            target.setPointerCapture(e.pointerId);
            target.classList.add('active');
            // 按下时锁定的几何锚（全局点，左上原点），全程不再回读窗口几何。
            const winLeft = e.screenX - e.clientX;
            const winTop = e.screenY - e.clientY;
            const h0 = window.innerHeight;
            const bottomY = winTop + h0; // 顶边拖时的固定底锚
            const startScreenY = e.screenY;
            const grabY = e.clientY;
            let height = h0;
            const onMove = (ev: PointerEvent) => {
                if (edge === 'bottom') {
                    // 底边跟随光标、顶边（origin）不动 → 纯改高度（起始高度 + 光标
                    // 位移），无需移动窗口。
                    height = Math.max(360, h0 + (ev.screenY - startScreenY));
                    void invoke('cmd_fb_set_companion_size', { width: WIN_W, height });
                } else {
                    // 顶边跟随光标、底边锚定：绝对算 newTop/height，不送增量。
                    let newTop = ev.screenY - grabY;
                    height = Math.max(360, bottomY - newTop);
                    newTop = bottomY - height; // 触底夹紧后回算顶，保持底锚不动
                    void invoke('cmd_fb_set_companion_size', { width: WIN_W, height });
                    void invoke('cmd_fb_move_companion_to', { x: winLeft, y: newTop });
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
        // 抓取偏移在按下时锁定；落点 = 光标 − 抓取偏移（绝对，跨屏不闪）。尺寸
        // 不变，纯平移走 move（不动 size）。
        const grabX = e.clientX;
        const grabY = e.clientY;
        const onMove = (ev: PointerEvent) => {
            const { x, y } = computeDragOrigin(ev.screenX, ev.screenY, grabX, grabY);
            void invoke('cmd_fb_move_companion_to', { x, y });
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
            className={`fbw-win ${mode === 'pin' ? 'pin' : 'peek'}${mode === 'hidden' ? ' hidden' : ''}`}
            onMouseDown={onWinMouseDown}
            onClick={onWinClick}
            onWheel={onWinWheel}
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
                <button onClick={() => setShowSettings((s) => !s)} title="悬浮球设置（工作区 / 新对话）">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                </button>
                <button onClick={onExpand} title="在 MyAgents 中打开（新 Tab 接上这条会话）">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17L17 7" /><path d="M9 7h8v8" /></svg>
                </button>
                <button onClick={hideSelf} title="关闭（Esc）">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
                </button>
            </div>

            {/* 会话流 */}
            <div className="fbw-convo" ref={convoRef} onScroll={onConvoScroll}>
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
                        <div className="fbw-msg ai ai-message-content" key={m.id}>
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
                    <div className="fbw-msg ai ai-message-content" key="streaming">
                        <Markdown>{session.streamText}</Markdown>
                        <span className="fbw-caret" />
                    </div>
                )}
                {/* 交互表单（D13）：复用主 Chat 同款组件，能力对等、视觉随设计
                    token 收敛。fb 窗是主 Vite app 的懒加载路由，Tailwind + @theme
                    token 天然可用，组件原样渲染。每类卡片缺一不可——漏接会让本轮
                    永久 hang（PRD §14.1）。 */}
                {(session.permReq || session.askReq || session.planReq) && (
                    <div className="fbw-forms">
                        {session.permReq && (
                            <PermissionPrompt
                                request={session.permReq}
                                onDecision={(_, decision) => void session.respondPermission(decision)}
                            />
                        )}
                        {session.askReq && (
                            <AskUserQuestionPrompt
                                request={session.askReq}
                                onSubmit={(_, answers) => void session.respondAskUserQuestion(answers)}
                                onCancel={() => void session.respondAskUserQuestion(null)}
                            />
                        )}
                        {session.planReq && (
                            <ExitPlanModePrompt
                                key={session.planReq.requestId}
                                request={session.planReq}
                                onApprove={() => void session.respondExitPlanMode(true)}
                                onReject={(feedback) => void session.respondExitPlanMode(false, feedback)}
                            />
                        )}
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
                        <button className="q-thumb" onClick={() => setShotPreview(true)} title="查看大图">
                            <img src={shot.dataUrl} alt="截图缩略图" draggable={false} />
                        </button>
                        <span className="q-text">
                            {shot.appName
                                ? `${shot.appName}${shot.windowTitle ? ` — ${shot.windowTitle}` : ''}`
                                : '屏幕截图 · 刚刚'}
                        </span>
                        <button
                            className="q-x"
                            onClick={() => {
                                setShot(null);
                                setShotPreview(false);
                            }}
                            title="去掉截图"
                        >
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

            {/* 截图大图预览（缩略图点开；Esc/点任意处关闭）。伴侣窗是独立
                webview、无 Tab 体系，不接 useCloseLayer；遮罩按红线用
                OverlayBackdrop。圆角跟玻璃容器，遮罩不溢出窗口弧度。 */}
            {shotPreview && shot && (
                <OverlayBackdrop
                    variant="dark"
                    onClose={() => setShotPreview(false)}
                    className="z-20 rounded-[24px] cursor-zoom-out"
                >
                    <img
                        src={shot.dataUrl}
                        alt="屏幕截图"
                        draggable={false}
                        className="fbw-shot-full"
                        onClick={() => setShotPreview(false)}
                    />
                </OverlayBackdrop>
            )}

            {/* 设置面板（齿轮，D17）：当前唯一有效内容 = 工作区绑定 + 新对话。
                遮罩同 lightbox 走 OverlayBackdrop（伴侣窗无 Tab 体系不接
                useCloseLayer）。OverlayBackdrop 以 onMouseDown + target===currentTarget
                判关闭，子元素点击本就不冒泡触发关闭，故面板无需 stopPropagation。 */}
            {showSettings && (
                <OverlayBackdrop
                    variant="dark"
                    onClose={() => setShowSettings(false)}
                    className="z-20 rounded-[24px]"
                >
                    <div className="fbw-settings">
                        <div className="fbw-settings-title">悬浮球设置</div>
                        <div className="fbw-settings-row">
                            <span className="fbw-settings-label">绑定工作区</span>
                            <CustomSelect
                                value={session.workspaceOverride ?? ''}
                                size="md"
                                options={[
                                    { value: '', label: '跟随默认工作区' },
                                    ...session.projects.map((p) => ({ value: p.path, label: p.name })),
                                ]}
                                onChange={(v) => void session.setWorkspaceBinding(v || null)}
                            />
                        </div>
                        <button
                            className="fbw-settings-action"
                            onClick={() => {
                                void session.newConversation();
                                setShowSettings(false);
                            }}
                        >
                            新对话
                        </button>
                        <div className="fbw-settings-hint">
                            默认跟随启动页默认工作区；选具体工作区则钉死在它。切换工作区或新对话都会开启一条全新会话（旧会话留在历史，可经 ↗ 找回）。
                        </div>
                    </div>
                </OverlayBackdrop>
            )}
        </div>
    );
}
