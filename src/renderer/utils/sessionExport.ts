/**
 * Export a session's full message history as a downloadable Markdown file.
 *
 * Shared by SessionHistoryDropdown's per-row export action and the in-Chat
 * session menu (SessionMenuButton). Returns a result object so the caller
 * can drive its own toast / spinner.
 */

import { getSessionDetails } from '@/api/sessionClient';

export interface SessionExportResult {
    ok: boolean;
    /** Pre-formatted toast message (success: download path; failure: reason) */
    message: string;
    /** True when the session existed but had no exportable content */
    empty?: boolean;
}

/** Extract text from assistant message stored as JSON content blocks. */
function extractAssistantText(content: string): string {
    try {
        const blocks = JSON.parse(content);
        if (!Array.isArray(blocks)) return content;
        return blocks
            .filter((b: { type: string }) => b.type === 'text')
            .map((b: { text: string }) => b.text)
            .join('\n\n');
    } catch {
        return content;
    }
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function fmtTs(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export async function exportSessionAsMarkdown(sessionId: string): Promise<SessionExportResult> {
    try {
        const data = await getSessionDetails(sessionId);
        if (!data || data.messages.length === 0) {
            return { ok: false, message: '该对话暂无内容可导出', empty: true };
        }

        const now = new Date();
        const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

        const lines: string[] = [];
        lines.push(`<!-- Exported from MyAgents · ${dateStr} -->`);
        lines.push(`<!-- Session: ${data.title} -->`);
        lines.push('');

        for (const msg of data.messages) {
            const roleLabel = msg.role === 'user' ? 'User' : 'Assistant';
            lines.push(`[ ${roleLabel} | ${fmtTs(msg.timestamp)} ]`);
            lines.push('');
            const text = msg.role === 'assistant'
                ? extractAssistantText(msg.content)
                : msg.content;
            lines.push(text);
            lines.push('');
            lines.push('---');
            lines.push('');
        }

        const markdown = lines.join('\n');
        const safeTitle = data.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 60);
        const fileName = `${dateStr}_${safeTitle}.md`;

        const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        try {
            const { downloadDir, join: joinPath } = await import('@tauri-apps/api/path');
            const dlDir = await downloadDir();
            const fullPath = await joinPath(dlDir, fileName);
            return { ok: true, message: `已导出：${fullPath}` };
        } catch {
            return { ok: true, message: `已导出到下载目录：${fileName}` };
        }
    } catch {
        return { ok: false, message: '导出失败，请重试' };
    }
}
