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
import { computeDragOrigin } from './fbDrag';
import { PetSprite } from './PetSprite';
import { getPetAnimationDuration } from './petAtlas';
import { derivePetAnimation, type FbBallState, type FbPendingKind, type PetDragDirection } from './petStateMapper';
import './fb.css';

const DRAG_THRESHOLD = 4;
const SUMMON_PULSE_MS = getPetAnimationDuration(MINO_DEFAULT_PET_PACK.atlas, 'jumping');
const DONE_PULSE_MS = getPetAnimationDuration(MINO_DEFAULT_PET_PACK.atlas, 'waving');
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

    // 绝对落点拖拽（修跨屏闪烁，见 fbDrag.ts）：
    //   grabX/Y  = pointerdown 时光标在 92×92 窗口内的偏移，全程恒定
    //   startX/Y = pointerdown 的光标全局点，仅用于跨过 DRAG_THRESHOLD 判定
    //   targetX/Y= 最新一帧算出的窗口绝对落点（rAF 节流后送 Rust）
    const dragRef = useRef<{
        active: boolean;
        moved: boolean;
        startX: number;
        startY: number;
        grabX: number;
        grabY: number;
        targetX: number;
        targetY: number;
        hasTarget: boolean;
        raf: number | null;
    }>({
        active: false,
        moved: false,
        startX: 0,
        startY: 0,
        grabX: 0,
        grabY: 0,
        targetX: 0,
        targetY: 0,
        hasTarget: false,
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
                    }, DONE_PULSE_MS);
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
    }, []);

    useEffect(() => {
        return () => {
            if (summonPulseTimerRef.current) clearTimeout(summonPulseTimerRef.current);
            if (popTimerRef.current) clearTimeout(popTimerRef.current);
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadAppConfig()
            .then((cfg) => {
                if (cancelled) return;
                setAppearance(cfg.floatingBallAppearance ?? 'pet');
            })
            .catch((err) => {
                console.warn('[fb-ball] load config failed for appearance:', err);
            });
        return () => {
            cancelled = true;
        };
    }, []);

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
        }, SUMMON_PULSE_MS);
    }, []);

    // ── hover：纯视觉瞥一眼（焦点纹丝不动，D1） ──
    // DOM mouseenter（app 激活态）与原生 NSTrackingArea（非激活态，经
    // fb:native-hover）两路信号汇入同一对 handler，用 ref 暴露给监听 effect。
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hoverInsideRef = useRef(false);
    const handleMouseEnter = useCallback(() => {
        if (hoverInsideRef.current) return; // 双路信号去重
        hoverInsideRef.current = true;
        if (dragRef.current.active) return;
        if (companionModeRef.current === 'pin') return; // already open for real
        // Small intent delay so a fly-by cursor doesn't flash the panel.
        // 60ms：加上轮询间隔 60ms，hover→出窗最坏 ~120ms + IPC，体感即时。
        hoverTimerRef.current = setTimeout(() => {
            void invoke('cmd_fb_show_companion', { mode: 'peek' });
            void invoke('cmd_fb_relay', { target: 'companion', event: 'fb:ball-enter', payload: {} });
        }, 60);
    }, []);
    const handleMouseLeave = useCallback(() => {
        if (!hoverInsideRef.current) return;
        hoverInsideRef.current = false;
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
        void invoke('cmd_fb_relay', { target: 'companion', event: 'fb:ball-leave', payload: {} });
    }, []);
    // 原生 hover（修 hover 失灵）：app 非激活时 WKWebView 收不到 mouseMoved，
    // DOM mouseenter 不触发——可靠信号来自 NSTrackingArea（Rust 转发）。DOM
    // 路径保留作激活态冗余，两路经 hoverInsideRef 去重。handlers 是空依赖
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
            void invoke('cmd_fb_relay', { target: 'companion', event: 'fb:close-request', payload: {} });
            return;
        }
        pulseSummon();
        // 1) 立即出窗 + 进入 pin（伴侣窗瞬时聚焦输入框）
        void invoke('cmd_fb_show_companion', { mode: 'pin' }).catch((err) => {
            console.error('[fb-ball] show pin failed:', err);
        });
        relayToCompanion('fb:summon', {});
        // 2) context 并行抓，到了再补进去（引用条/标题行晚到一拍，可接受）
        try {
            const ctx = await invoke('cmd_fb_capture_context');
            relayToCompanion('fb:summon-ctx', { ctx });
        } catch (err) {
            console.warn('[fb-ball] capture_context failed:', err);
        }
    }, [pulseSummon, relayToCompanion]);

    // ── drag / snap ──
    // 绝对落点：每帧把「最新算出的窗口原点」整笔送 Rust（last-wins），而不是
    // 送增量。Rust 不回读窗口位置 → 无「读改写振荡」→ 跨屏不闪（见 fbDrag.ts）。
    const flushDrag = useCallback(() => {
        const d = dragRef.current;
        d.raf = null;
        if (!d.hasTarget) return;
        d.hasTarget = false;
        void invoke('cmd_fb_move_ball_to', { x: d.targetX, y: d.targetY });
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const d = dragRef.current;
        d.active = true;
        d.moved = false;
        d.startX = e.screenX;
        d.startY = e.screenY;
        // 抓取偏移 = 光标在窗口内的位置（clientX/Y）。落点 = 光标 − 它，让抓取
        // 点始终钉在光标下。pointerdown 时光标必在窗口内，故 clientX/Y 可信；
        // 之后即便 setPointerCapture 把光标拖出窗外也不再用 clientX/Y（只用
        // 全局的 screenX/Y）。
        d.grabX = e.clientX;
        d.grabY = e.clientY;
        d.hasTarget = false;
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
            const t = computeDragOrigin(e.screenX, e.screenY, d.grabX, d.grabY);
            d.targetX = t.x;
            d.targetY = t.y;
            d.hasTarget = true;
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
        // 丢掉未派发的那一帧 move：松手落点 (targetX/Y) 直接交给 snap 作权威
        // 落点（snap 用它算吸边/屏、不回读 outer_position），免得尾随的一帧
        // move 在 snap 之后又把球拽回光标位置。
        if (d.raf !== null) {
            cancelAnimationFrame(d.raf);
            d.raf = null;
        }
        if (d.moved) {
            d.moved = false;
            setDragging(false);
            setDragDirectionStable('none');
            void invoke('cmd_fb_snap_ball', { x: d.targetX, y: d.targetY });
            return true;
        }
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
                            pack={MINO_DEFAULT_PET_PACK}
                            animation={petAnimation}
                            title={`${MINO_DEFAULT_PET_PACK.displayName} · ${BALL_STATE_LABEL[state]}`}
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
