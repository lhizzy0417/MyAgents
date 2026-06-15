/**
 * Floating ball window (PRD 0.2.35) — the 92×92 transparent NSPanel.
 *
 * Owns: ball visuals (idle/running/blocked/done), hover → peek, click → pin
 * (with eager context capture BEFORE the companion takes key — D3), drag →
 * snap-to-edge. All cross-window coordination goes through Rust
 * (`cmd_fb_relay`) because the companion lives in a separate webview.
 *
 * D1 red line: hover NEVER captures context and NEVER moves keyboard focus —
 * peek is `order_front_regardless` on the Rust side (no key window change).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { loadAppConfig } from '@/config/services/appConfigService';
import { listenWithCleanup } from '@/utils/tauriListen';

import { MINO_DEFAULT_PET_PACK } from './defaultPetPack';
import {
    createFloatingBallHoverIntentState,
    enterFloatingBallHover,
    leaveFloatingBallHover,
    resetFloatingBallHoverIntent,
    suppressHoverPeekAfterBallClose,
} from './hoverIntent';
import { resolveSelectedPetPack } from './petPackLibrary';
import { PetSprite } from './PetSprite';
import { getPetAnimationDuration } from './petAtlas';
import { derivePetAnimation, type FbBallState, type FbPendingKind, type PetDragDirection } from './petStateMapper';
import './fb.css';

interface FbCtx {
    appName?: string | null;
    windowTitle?: string | null;
    selection?: string | null;
}

const DRAG_THRESHOLD = 4;
const CLOSE_HOVER_SUPPRESS_MS = 500;
const BALL_STATE_LABEL: Record<FbBallState, string> = {
    idle: '空闲',
    running: '正在处理',
    blocked: '等你确认',
    done: '有结果未读',
};

export default function BallWindow() {
    const [state, setState] = useState<FbBallState>('idle');
    const [unread, setUnread] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [dragDirection, setDragDirection] = useState<PetDragDirection>('none');
    const [pop, setPop] = useState(false);
    const [summonPulse, setSummonPulse] = useState(false);
    const [pendingKind, setPendingKind] = useState<FbPendingKind | null>(null);
    const [hasError, setHasError] = useState(false);
    const [petLoadFailed, setPetLoadFailed] = useState(false);
    const [appearance, setAppearance] = useState<'pet' | 'orb'>('pet');
    const [petPack, setPetPack] = useState(MINO_DEFAULT_PET_PACK);
    const summonPulseMs = useMemo(() => getPetAnimationDuration(petPack.atlas, 'jumping'), [petPack]);
    const donePulseMs = useMemo(() => getPetAnimationDuration(petPack.atlas, 'waving'), [petPack]);

    // Companion mode mirror (companion relays its mode changes) so a click on
    // the ball can toggle: hidden/peek → summon, pinned → close.
    const companionModeRef = useRef<'hidden' | 'peek' | 'pin'>('hidden');
    // Boot-race guard (review W1): Tauri events have no replay — a summon
    // fired before the companion registered its listeners would vanish. Track
    // readiness via the fb:companion-ready handshake and queue pending events
    // to re-deliver in order.
    const companionReadyRef = useRef(false);
    const pendingEventsRef = useRef<Array<{ event: string; payload: unknown }>>([]);
    const relayToCompanion = useCallback((event: string, payload: unknown) => {
        if (companionReadyRef.current) {
            void invoke('cmd_fb_relay', { target: 'companion', event, payload });
        } else {
            pendingEventsRef.current.push({ event, payload });
        }
    }, []);
    // Previous ball state for done-transition pop (kept OUT of the setState
    // updater — updaters must stay pure under concurrent rendering).
    const prevStateRef = useRef<FbBallState>('idle');
    const dragDirectionRef = useRef<PetDragDirection>('none');
    const summonPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const popTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverPeekEnabledRef = useRef(true);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverIntentRef = useRef(createFloatingBallHoverIntentState());

    // 原生坐标拖拽（修副屏跳屏）：renderer 只负责 pointer 生命周期和
    // threshold/动画；窗口落点由 Rust 用 NSEvent.mouseLocation + 当前窗口
    // frame 计算，避免把 WebView screenX/Y 混成 Tauri/AppKit 窗口坐标。
    const dragRef = useRef<{
        active: boolean;
        moved: boolean;
        startX: number;
        startY: number;
        raf: number | null;
    }>({
        active: false,
        moved: false,
        startX: 0,
        startY: 0,
        raf: null,
    });

    // ── state pushed from the companion (it owns the session SSE) ──
    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup<{ state: FbBallState; count?: number; pendingKind?: FbPendingKind; hasError?: boolean }>(
            'fb:state',
            (e) => {
                const next = e.payload?.state ?? 'idle';
                if (next === 'done' && prevStateRef.current !== 'done') {
                    if (popTimerRef.current) clearTimeout(popTimerRef.current);
                    setPop(true);
                    popTimerRef.current = setTimeout(() => {
                        setPop(false);
                        popTimerRef.current = null;
                    }, donePulseMs);
                }
                prevStateRef.current = next;
                setState(next);
                setUnread(e.payload?.count ?? 0);
                setPendingKind(e.payload?.pendingKind ?? null);
                setHasError(Boolean(e.payload?.hasError));
            },
            ac.signal,
        );
        void listenWithCleanup<{ mode: 'hidden' | 'peek' | 'pin' }>(
            'fb:companion-mode',
            (e) => {
                companionModeRef.current = e.payload?.mode ?? 'hidden';
            },
            ac.signal,
        );
        void listenWithCleanup(
            'fb:companion-ready',
            () => {
                companionReadyRef.current = true;
                const pending = pendingEventsRef.current;
                pendingEventsRef.current = [];
                for (const { event, payload } of pending) {
                    void invoke('cmd_fb_relay', { target: 'companion', event, payload });
                }
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [donePulseMs]);

    useEffect(() => {
        return () => {
            if (summonPulseTimerRef.current) clearTimeout(summonPulseTimerRef.current);
            if (popTimerRef.current) clearTimeout(popTimerRef.current);
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        };
    }, []);

    const loadBallConfig = useCallback(async () => {
        const cfg = await loadAppConfig();
        setAppearance(cfg.floatingBallAppearance ?? 'pet');
        hoverPeekEnabledRef.current = cfg.floatingBallHoverPeekEnabled !== false;
        if (!hoverPeekEnabledRef.current) {
            if (hoverTimerRef.current) {
                clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            resetFloatingBallHoverIntent(hoverIntentRef.current);
            if (companionModeRef.current === 'peek') {
                void invoke('cmd_fb_hide_companion');
                relayToCompanion('fb:force-hidden', {});
            }
        }
        const nextPack = await resolveSelectedPetPack(cfg.floatingBallPetId);
        setPetPack(nextPack);
        setPetLoadFailed(false);
    }, [relayToCompanion]);

    useEffect(() => {
        let cancelled = false;
        const timer = window.setTimeout(() => {
            if (cancelled) return;
            void loadBallConfig().catch((err) => {
                console.warn('[fb-ball] load config failed:', err);
            });
        }, 0);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [loadBallConfig]);

    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup(
            'fb:config-changed',
            () => {
                void loadBallConfig().catch((err) => {
                    console.warn('[fb-ball] reload config failed:', err);
                });
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [loadBallConfig]);

    const setDragDirectionStable = useCallback((next: PetDragDirection) => {
        if (dragDirectionRef.current === next) return;
        dragDirectionRef.current = next;
        setDragDirection(next);
    }, []);

    const pulseSummon = useCallback(() => {
        if (summonPulseTimerRef.current) clearTimeout(summonPulseTimerRef.current);
        setSummonPulse(true);
        summonPulseTimerRef.current = setTimeout(() => {
            setSummonPulse(false);
            summonPulseTimerRef.current = null;
        }, summonPulseMs);
    }, [summonPulseMs]);

    // ── hover：纯视觉瞥一眼（焦点纹丝不动，D1） ──
    // DOM mouseenter（app 激活态）与原生 NSTrackingArea（非激活态，经
    // fb:native-hover）两路信号汇入同一对 handler，用 ref 暴露给监听 effect。
    const handleMouseEnter = useCallback(() => {
        const shouldStartPeek = enterFloatingBallHover(
            hoverIntentRef.current,
            {
                hoverEnabled: hoverPeekEnabledRef.current,
                dragging: dragRef.current.active,
                companionPinned: companionModeRef.current === 'pin',
            },
            Date.now(),
        );
        if (!shouldStartPeek) return;
        // Small intent delay so a fly-by cursor doesn't flash the panel.
        // 60ms：加上轮询间隔 60ms，hover→出窗最坏 ~120ms + IPC，体感即时。
        hoverTimerRef.current = setTimeout(() => {
            hoverTimerRef.current = null;
            void (async () => {
                try {
                    await invoke('cmd_fb_show_companion', { mode: 'peek' });
                    if (!hoverIntentRef.current.inside || dragRef.current.active) {
                        if (companionModeRef.current !== 'pin') {
                            void invoke('cmd_fb_hide_companion').catch(() => undefined);
                        }
                        return;
                    }
                    if (companionModeRef.current === 'pin') return;
                    relayToCompanion('fb:ball-enter', {});
                } catch (err) {
                    hoverIntentRef.current.inside = false;
                    console.warn('[fb-ball] show peek failed:', err);
                }
            })();
        }, 60);
    }, [relayToCompanion]);
    const handleMouseLeave = useCallback(() => {
        if (!leaveFloatingBallHover(hoverIntentRef.current)) return;
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        void invoke('cmd_fb_relay', { target: 'companion', event: 'fb:ball-leave', payload: {} });
    }, []);
    // 原生 hover（修 hover 失灵）：app 非激活时 WKWebView 收不到 mouseMoved，
    // DOM mouseenter 不触发——可靠信号来自 NSTrackingArea（Rust 转发）。DOM
    // 路径保留作激活态冗余，两路经 hoverIntentRef 去重。handlers 是空依赖
    // useCallback（稳定身份），effect 只跑一次。
    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup<{ inside?: boolean }>(
            'fb:native-hover',
            (e) => {
                if (e.payload?.inside) handleMouseEnter();
                else handleMouseLeave();
            },
            ac.signal,
        );
        return () => ac.abort();
    }, [handleMouseEnter, handleMouseLeave]);

    // ── click → summon ──
    // 性能关键（用户反馈"点击卡卡的"）：窗口显示**不等** capture——AX 读选区
    // 可达 100-300ms，串行会把 pin 的视觉反馈压在后面。并行是安全的：
    // nonactivating panel 永不改变 frontmost app，capture 读的始终是用户
    // 的 app（探针按 frontmost 定位，与我们窗口的 key 状态无关）。D3 红线
    // 不变：capture 仍只在显式点击时发起，hover 永不碰。
    const summon = useCallback(async () => {
        if (companionModeRef.current === 'pin') {
            // Toggle: ball click while pinned closes the companion.
            if (hoverTimerRef.current) {
                clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }
            suppressHoverPeekAfterBallClose(hoverIntentRef.current, Date.now(), CLOSE_HOVER_SUPPRESS_MS);
            relayToCompanion('fb:close-request', {});
            return;
        }
        pulseSummon();
        const contextPromise = invoke<FbCtx>('cmd_fb_capture_context').catch((err) => {
            console.warn('[fb-ball] capture_context failed:', err);
            return null;
        });
        // 1) 立即出窗 + 进入 pin（伴侣窗瞬时聚焦输入框）。只有 native
        // 接受 show 后才发 React 事件；禁用后的 stale click 不能留下逻辑 pin。
        try {
            await invoke('cmd_fb_show_companion', { mode: 'pin' });
        } catch (err) {
            void contextPromise;
            console.error('[fb-ball] show pin failed:', err);
            return;
        }
        relayToCompanion('fb:summon', {});
        // 2) context 并行抓，到了再补进去（引用条/标题行晚到一拍，可接受）
        const ctx = await contextPromise;
        if (ctx) {
            relayToCompanion('fb:summon-ctx', { ctx });
        }
    }, [pulseSummon, relayToCompanion]);

    // ── drag / snap ──
    // Renderer 只节流 pointermove；每帧窗口落点由 Rust 用 native 鼠标位置
    // 和按下时的窗口 frame 计算，避免浏览器事件坐标与 AppKit 窗口坐标混用。
    const flushDrag = useCallback(() => {
        const d = dragRef.current;
        d.raf = null;
        void invoke('cmd_fb_drag_ball_move');
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const d = dragRef.current;
        d.active = true;
        d.moved = false;
        d.startX = e.screenX;
        d.startY = e.screenY;
        void invoke('cmd_fb_drag_ball_start').catch((err) => {
            console.warn('[fb-ball] start native drag failed:', err);
        });
        setDragDirectionStable('none');
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, [setDragDirectionStable]);

    const onPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const d = dragRef.current;
            if (!d.active) return;
            if (!d.moved) {
                if (
                    Math.abs(e.screenX - d.startX) < DRAG_THRESHOLD &&
                    Math.abs(e.screenY - d.startY) < DRAG_THRESHOLD
                ) {
                    return;
                }
                d.moved = true;
                setDragging(true);
                setDragDirectionStable('none');
                // Drop any peek while dragging.
                void invoke('cmd_fb_hide_companion');
                void invoke('cmd_fb_relay', { target: 'companion', event: 'fb:force-hidden', payload: {} });
            }
            const dx = e.screenX - d.startX;
            if (Math.abs(dx) >= 12) {
                setDragDirectionStable(dx < 0 ? 'left' : 'right');
            }
            if (d.raf === null) {
                d.raf = requestAnimationFrame(flushDrag);
            }
        },
        [flushDrag, setDragDirectionStable],
    );

    const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>): boolean => {
        const d = dragRef.current;
        if (!d.active) return false;
        d.active = false;
        try {
            (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
            // capture may already be lost (pointercancel path)
        }
        // 丢掉未派发的那一帧 move：松手时 Rust 会用同一 native drag session
        // 计算最终落点并吸边，尾随 move 看到 session 已清空会 no-op。
        if (d.raf !== null) {
            cancelAnimationFrame(d.raf);
            d.raf = null;
        }
        if (d.moved) {
            d.moved = false;
            setDragging(false);
            setDragDirectionStable('none');
            void invoke('cmd_fb_drag_ball_end').catch((err) => {
                console.warn('[fb-ball] end native drag failed:', err);
            });
            return true;
        }
        void invoke('cmd_fb_drag_ball_cancel').catch(() => undefined);
        return false;
    }, [setDragDirectionStable]);

    const onPointerUp = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const d = dragRef.current;
            if (!d.active) return;
            const wasDrag = endDrag(e);
            if (!wasDrag) void summon();
        },
        [endDrag, summon],
    );

    // Mission Control / display sleep can cancel the pointer stream mid-drag —
    // end the drag (snap if moved) but NEVER treat it as a click/summon.
    const onPointerCancel = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            endDrag(e);
        },
        [endDrag],
    );

    const petAnimation = useMemo(
        () =>
            derivePetAnimation({
                ballState: state,
                pendingKind,
                dragging,
                dragDirection,
                summonPulse,
                donePulse: pop,
                hasError,
            }),
        [dragDirection, dragging, hasError, pendingKind, pop, state, summonPulse],
    );
    const handlePetLoadError = useCallback(() => {
        console.warn('[fb-ball] pet spritesheet failed to load; falling back to orb');
        setPetLoadFailed(true);
    }, []);
    const usePet = appearance === 'pet' && !petLoadFailed;

    return (
        <div className="fbw-ball-stage" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
            <div
                className={`fbw-ball${usePet ? ' pet-mode' : ''} state-${state}${dragging ? ' dragging' : ''}${pop ? ' pop' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
            >
                {usePet ? (
                    <>
                        <span className="fbw-pet-pad" />
                        <span className="ring" />
                        <span className="ripple r1" />
                        <span className="ripple r2" />
                        <PetSprite
                            pack={petPack}
                            animation={petAnimation}
                            title={`${petPack.displayName} · ${BALL_STATE_LABEL[state]}`}
                            onLoadError={handlePetLoadError}
                        />
                    </>
                ) : (
                    <>
                        <span className="ring" />
                        <span className="ripple r1" />
                        <span className="ripple r2" />
                        <span className="gloss" />
                        <span className="core" />
                    </>
                )}
                <span className="badge">{unread || ''}</span>
            </div>
        </div>
    );
}
