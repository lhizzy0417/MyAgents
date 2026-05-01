/**
 * CustomTitleBar - Chrome-style titlebar with integrated tabs
 *
 * Key insight: data-tauri-drag-region must be on SPECIFIC draggable elements,
 * not just the parent container. Also, -webkit-app-region CSS CONFLICTS with
 * Tauri's mechanism on macOS WebKit.
 *
 * Windows: Custom window controls (minimize, maximize, close) are added since
 * we use decorations: false on Windows for custom title bar styling.
 */

import { Bot, Minus, Square, X, RefreshCw, Settings, Copy, CheckSquare } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/api/tauriClient';
import { CUSTOM_EVENTS } from '@/../shared/constants';
import FeedbackPopover from './FeedbackPopover';

interface CustomTitleBarProps {
    children: ReactNode;  // TabBar component
    onSettingsClick?: () => void;
    onOpenBugReport?: () => void;
    /** Whether an update is ready to install */
    updateReady?: boolean;
    /** Version of the update ready to install */
    updateVersion?: string | null;
    /** Whether an install is currently in flight (post-click). When true the
     *  button shows a spinner and is disabled to prevent double-clicks. */
    updateInstalling?: boolean;
    /** Whether a silent download is replacing the pending bytes. When true
     *  the button hides entirely — clicking install mid-replacement would
     *  land on inconsistent cache/disk state. The button reappears with the
     *  new version once the replacement commits. */
    updatePreparing?: boolean;
    /** Callback when user clicks "Restart to Update" */
    onRestartAndUpdate?: () => void;
}

// macOS traffic lights (close/minimize/maximize) width + padding
const MACOS_TRAFFIC_LIGHTS_WIDTH = 78;

// Detect platform
const isWindows = typeof navigator !== 'undefined' && navigator.platform?.includes('Win');

export default function CustomTitleBar({
    children,
    onSettingsClick,
    onOpenBugReport,
    updateReady,
    updateVersion,
    updateInstalling,
    updatePreparing,
    onRestartAndUpdate,
}: CustomTitleBarProps) {
    const [isFullscreen, setIsFullscreen] = useState(false);
    const [isMaximized, setIsMaximized] = useState(false);
    const [showFeedback, setShowFeedback] = useState(false);
    const feedbackBtnRef = useRef<HTMLDivElement>(null);

    const handleOpenBugReport = useCallback(() => {
        setShowFeedback(false);
        onOpenBugReport?.();
    }, [onOpenBugReport]);

    // Listen for fullscreen changes
    useEffect(() => {
        if (!isTauri()) return;

        let mounted = true;

        const checkWindowState = async () => {
            if (!mounted) return;
            try {
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                const win = getCurrentWindow();
                const fs = await win.isFullscreen();
                const max = await win.isMaximized();
                if (mounted) {
                    setIsFullscreen(fs);
                    setIsMaximized(max);
                }
            } catch (e) {
                console.error('Failed to check window state:', e);
            }
        };

        // Initial check
        checkWindowState();

        // Use resize event listener with debounce instead of polling
        // macOS fullscreen exit animation takes ~500-700ms, so we do a
        // second delayed check to catch the final state after animation.
        let resizeTimeout: NodeJS.Timeout;
        let animationTimeout: NodeJS.Timeout;
        const onResize = () => {
            clearTimeout(resizeTimeout);
            clearTimeout(animationTimeout);
            resizeTimeout = setTimeout(checkWindowState, 150);
            animationTimeout = setTimeout(checkWindowState, 700);
        };

        window.addEventListener('resize', onResize);

        return () => {
            mounted = false;
            window.removeEventListener('resize', onResize);
            clearTimeout(resizeTimeout);
            clearTimeout(animationTimeout);
        };
    }, []);

    // Windows window control handlers
    const handleMinimize = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().minimize();
        } catch (e) {
            console.error('Failed to minimize:', e);
        }
    };

    const handleMaximize = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            const win = getCurrentWindow();
            if (await win.isMaximized()) {
                await win.unmaximize();
            } else {
                await win.maximize();
            }
        } catch (e) {
            console.error('Failed to toggle maximize:', e);
        }
    };

    const handleClose = async () => {
        if (!isTauri()) return;
        try {
            const { getCurrentWindow } = await import('@tauri-apps/api/window');
            await getCurrentWindow().close();
        } catch (e) {
            console.error('Failed to close:', e);
        }
    };

    return (
        <div
            className="custom-titlebar flex h-11 flex-shrink-0 items-center border-b border-[var(--line)] bg-gradient-to-b from-[var(--paper)] to-[var(--paper-inset)]/30"
        >
            {/* macOS traffic lights spacer - DRAGGABLE (hidden on Windows) */}
            {!isWindows && !isFullscreen && (
                <div
                    className="flex-shrink-0 h-full"
                    style={{ width: MACOS_TRAFFIC_LIGHTS_WIDTH }}
                    data-tauri-drag-region
                />
            )}

            {/* Windows: Small left padding for drag area */}
            {isWindows && (
                <div
                    className="flex-shrink-0 h-full w-3"
                    data-tauri-drag-region
                />
            )}

            {/* Tabs area - NOT draggable */}
            <div
                className="flex h-full items-center overflow-hidden"
                data-no-drag
            >
                {children}
            </div>

            {/* Flexible spacer - DRAGGABLE */}
            <div
                className="flex-1 h-full"
                data-tauri-drag-region
            />

            {/* Right side actions - NOT draggable */}
            <div
                className="flex flex-shrink-0 items-center gap-1 px-3 h-full"
                data-no-drag
            >
                {/* Update button - only shown when update is ready AND no
                    silent replacement download is in flight. Spinner +
                    disabled state during install so the user sees immediate
                    feedback on click. Hidden during silent download because
                    the pending bytes are about to be replaced — clicking
                    install mid-replacement could land on inconsistent
                    cache/disk state. Reappears automatically when the
                    replacement commits (with the new version). */}
                {updateReady && !updatePreparing && (
                    <button
                        onClick={updateInstalling ? undefined : onRestartAndUpdate}
                        disabled={updateInstalling}
                        className="flex h-7 items-center gap-1.5 px-3 rounded-full text-xs font-medium text-white bg-[var(--success)] shadow-sm transition-all hover:bg-[var(--success)] active:scale-95 disabled:opacity-80 disabled:cursor-wait"
                        title={updateInstalling
                            ? '正在安装更新…'
                            : (updateVersion ? `更新到 v${updateVersion}` : '重启并更新')}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${updateInstalling ? 'animate-spin' : ''}`} />
                        <span>{updateInstalling ? '安装中…' : '重启更新'}</span>
                    </button>
                )}
                {/* Feedback button + popover */}
                {/* v0.1.69 polish: `transition-all` widened the transition
                    to *every* prop, including `transform`. The global
                    `:active { scale(0.98) }` rule in index.css then animated
                    *back* to scale(1) on mouseup over 150ms — visually it
                    reads as the button popping UP rather than sinking in
                    under the finger. `transition-colors` keeps the hover
                    bg fade smooth while letting the scale change snap
                    instantly in both directions, so the press feedback
                    lands as "down & back" without the return bounce. */}
                <div ref={feedbackBtnRef} className="relative">
                    <button
                        onClick={() => setShowFeedback(prev => !prev)}
                        className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 transition-colors ${
                            showFeedback
                                ? 'bg-[var(--paper-inset)] text-[var(--ink)]'
                                : 'text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]'
                        }`}
                        title="小助理"
                    >
                        <Bot className="h-4 w-4" />
                        <span className="text-[13px] font-medium">小助理</span>
                    </button>
                    <FeedbackPopover
                        open={showFeedback}
                        onClose={() => setShowFeedback(false)}
                        onOpenBugReport={handleOpenBugReport}
                        triggerRef={feedbackBtnRef}
                    />
                </div>

                {isTauri() && (
                    <button
                        onClick={() => window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.OPEN_TASK_CENTER))}
                        className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                        title={`任务中心 (${navigator.platform.toLowerCase().includes('mac') ? '⌘Y' : 'Ctrl+Y'})`}
                    >
                        <CheckSquare className="h-4 w-4" />
                        <span className="text-[13px] font-medium">任务</span>
                    </button>
                )}

                <button
                    onClick={onSettingsClick || (() => console.log('Settings clicked - TODO'))}
                    className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                    title={`设置 (${navigator.platform.toLowerCase().includes('mac') ? '⌘U' : 'Ctrl+U'})`}
                >
                    <Settings className="h-4 w-4" />
                    <span className="text-[13px] font-medium">设置</span>
                </button>
            </div>

            {/* Windows window controls */}
            {isWindows && (
                <div className="flex h-full items-stretch" data-no-drag>
                    <button
                        onClick={handleMinimize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
                        title="最小化"
                    >
                        <Minus className="h-4 w-4" />
                    </button>
                    <button
                        onClick={handleMaximize}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--paper-inset)] transition-colors"
                        title={isMaximized ? "还原" : "最大化"}
                    >
                        {isMaximized ? (
                            <Copy className="h-3.5 w-3.5" />
                        ) : (
                            <Square className="h-3.5 w-3.5" />
                        )}
                    </button>
                    <button
                        onClick={handleClose}
                        className="flex w-11 items-center justify-center text-[var(--ink-muted)] hover:bg-[var(--error)] hover:text-white transition-colors"
                        title="关闭"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
