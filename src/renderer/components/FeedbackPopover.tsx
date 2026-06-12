/**
 * FeedbackPopover - Quick access popover for AI assistant and community QR code
 *
 * Drops down from the feedback button in the titlebar.
 * Two modules: "AI 小助理" (opens BugReportOverlay) and "加入用户群" (shows QR code).
 */

import { useEffect, useState } from 'react';
import { Bot, Loader2, Users, X } from 'lucide-react';

import { apiGetJson } from '@/api/apiFetch';
import { Popover } from '@/components/ui/Popover';
import { isTauriEnvironment } from '@/utils/browserMock';

interface FeedbackPopoverProps {
    open: boolean;
    onClose: () => void;
    onOpenBugReport: () => void;
    /** Ref to the trigger button — anchors the popover. */
    triggerRef: React.RefObject<HTMLElement | null>;
}

const QR_CDN_URL = 'https://download.myagents.io/assets/feedback_qr_code.png';

export default function FeedbackPopover({ open, onClose, onOpenBugReport, triggerRef }: FeedbackPopoverProps) {
    const isTauri = isTauriEnvironment();
    const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(isTauri ? null : QR_CDN_URL);
    const [qrLoading, setQrLoading] = useState(isTauri);

    // Load QR code from Sidecar in Tauri mode
    useEffect(() => {
        if (!isTauri) return;
        let cancelled = false;

        apiGetJson<{ success: boolean; dataUrl?: string }>('/api/assets/qr-code')
            .then(result => {
                if (cancelled) return;
                if (result.success && result.dataUrl) {
                    setQrCodeUrl(result.dataUrl);
                }
            })
            .catch(() => { /* silent fail */ })
            .finally(() => { if (!cancelled) setQrLoading(false); });

        return () => { cancelled = true; };
    }, [isTauri]);

    return (
        <Popover
            open={open}
            onClose={onClose}
            anchorRef={triggerRef}
            placement="bottom-end"
            offset={6}
            zIndex={200}
            className="w-72 rounded-xl shadow-lg"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-3.5 pb-2">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ink-muted)]">
                    帮助与反馈
                </span>
                <button
                    onClick={onClose}
                    className="rounded-md p-0.5 text-[var(--ink-muted)] transition-colors hover:bg-[var(--paper-inset)] hover:text-[var(--ink)]"
                >
                    <X className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* AI 小助理 */}
            <div className="px-3 pb-2">
                <button
                    onClick={() => {
                        onClose();
                        onOpenBugReport();
                    }}
                    className="group w-full rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5
                        text-left transition-all hover:border-[var(--line-strong)] hover:shadow-sm"
                >
                    <div className="flex items-center gap-2.5">
                        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)] transition-colors group-hover:bg-[var(--accent-warm-muted)]">
                            <Bot className="h-4 w-4 text-[var(--accent-warm)]" />
                        </div>
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-[var(--ink)]">AI 小助理</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                                不会使用，反馈问题，意见建议快来找小助理！
                            </p>
                        </div>
                    </div>
                </button>
            </div>

            {/* 加入用户群 */}
            {(qrLoading || qrCodeUrl) && (
                <div className="px-3 pb-3.5">
                    <div className="rounded-lg border border-[var(--line)] bg-[var(--paper-elevated)] p-3.5">
                        <div className="flex items-center gap-2.5">
                            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--accent-warm-subtle)]">
                                <Users className="h-4 w-4 text-[var(--accent-warm)]" />
                            </div>
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-[var(--ink)]">加入用户交流群</p>
                                <p className="mt-0.5 text-xs leading-relaxed text-[var(--ink-muted)]">
                                    扫码加入，交流使用心得
                                </p>
                            </div>
                        </div>
                        <div className="mt-3 flex justify-center">
                            {qrLoading ? (
                                <div className="flex h-32 w-32 items-center justify-center">
                                    <Loader2 className="h-6 w-6 animate-spin text-[var(--ink-muted)]" />
                                </div>
                            ) : (
                                <img
                                    src={qrCodeUrl!}
                                    alt="用户交流群二维码"
                                    className="h-32 w-32 rounded-lg"
                                />
                            )}
                        </div>
                    </div>
                </div>
            )}
        </Popover>
    );
}
