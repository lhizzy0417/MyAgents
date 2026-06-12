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
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { listenWithCleanup } from '@/utils/tauriListen';

import './fb.css';

export type FbBallState = 'idle' | 'running' | 'blocked' | 'done';

const DRAG_THRESHOLD = 4;

export default function BallWindow() {
    const [state, setState] = useState<FbBallState>('idle');
    const [unread, setUnread] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [pop, setPop] = useState(false);

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

    const dragRef = useRef<{
        active: boolean;
        moved: boolean;
        lastX: number;
        lastY: number;
        pendingDx: number;
        pendingDy: number;
        raf: number | null;
    }>({ active: false, moved: false, lastX: 0, lastY: 0, pendingDx: 0, pendingDy: 0, raf: null });

    // ── state pushed from the companion (it owns the session SSE) ──
    useEffect(() => {
        const ac = new AbortController();
        void listenWithCleanup<{ state: FbBallState; count?: number }>(
            'fb:state',
            (e) => {
                const next = e.payload?.state ?? 'idle';
                if (next === 'done' && prevStateRef.current !== 'done') {
                    setPop(true);
                    setTimeout(() => setPop(false), 600);
                }
                prevStateRef.current = next;
                setState(next);
                setUnread(e.payload?.count ?? 0);
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
    }, [relayToCompanion]);

    // ── drag / snap ──
    const flushDrag = useCallback(() => {
        const d = dragRef.current;
        d.raf = null;
        const { pendingDx, pendingDy } = d;
        if (pendingDx === 0 && pendingDy === 0) return;
        d.pendingDx = 0;
        d.pendingDy = 0;
        void invoke('cmd_fb_drag_ball', { dx: pendingDx, dy: pendingDy });
    }, []);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        const d = dragRef.current;
        d.active = true;
        d.moved = false;
        d.lastX = e.screenX;
        d.lastY = e.screenY;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
    }, []);

    const onPointerMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const d = dragRef.current;
            if (!d.active) return;
            const dx = e.screenX - d.lastX;
            const dy = e.screenY - d.lastY;
            if (!d.moved) {
                if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
                d.moved = true;
                setDragging(true);
                // Drop any peek while dragging.
                void invoke('cmd_fb_hide_companion');
                void invoke('cmd_fb_relay', { target: 'companion', event: 'fb:force-hidden', payload: {} });
            }
            d.lastX = e.screenX;
            d.lastY = e.screenY;
            d.pendingDx += dx;
            d.pendingDy += dy;
            if (d.raf === null) {
                d.raf = requestAnimationFrame(flushDrag);
            }
        },
        [flushDrag],
    );

    const endDrag = useCallback(
        (e: React.PointerEvent<HTMLDivElement>): boolean => {
            const d = dragRef.current;
            if (!d.active) return false;
            d.active = false;
            try {
                (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
                // capture may already be lost (pointercancel path)
            }
            if (d.raf !== null) {
                cancelAnimationFrame(d.raf);
                flushDrag();
            }
            if (d.moved) {
                d.moved = false;
                setDragging(false);
                void invoke('cmd_fb_snap_ball');
                return true;
            }
            return false;
        },
        [flushDrag],
    );

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

    return (
        <div className="fbw-ball-stage" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
            <div
                className={`fbw-ball state-${state}${dragging ? ' dragging' : ''}${pop ? ' pop' : ''}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
            >
                <span className="ring" />
                <span className="ripple r1" />
                <span className="ripple r2" />
                <span className="gloss" />
                <span className="core" />
                <span className="badge">{unread || ''}</span>
            </div>
        </div>
    );
}
