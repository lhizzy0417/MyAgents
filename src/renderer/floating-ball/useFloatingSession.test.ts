import { describe, expect, it } from 'vitest';

import { extractMessageText, parseSessionHistory } from './useFloatingSession';

// extractMessageText 是伴侣窗历史回填的唯一文本解码器——SessionMessage.content
// 在磁盘上既可能是纯文本，也可能是 ContentBlock[] 的 JSON 字符串（assistant），
// 解码错误的症状是"恢复历史后整条消息消失/显示原始 JSON"。

describe('extractMessageText', () => {
    it('passes plain text through unchanged', () => {
        expect(extractMessageText('你好，Mino')).toBe('你好，Mino');
    });

    it('returns empty string for empty content', () => {
        expect(extractMessageText('')).toBe('');
    });

    it('joins text blocks from a ContentBlock[] JSON string', () => {
        const content = JSON.stringify([
            { type: 'text', text: '第一段' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: '第二段' },
        ]);
        expect(extractMessageText(content)).toBe('第一段\n\n第二段');
    });

    it('extracts text field from a JSON object payload', () => {
        expect(extractMessageText(JSON.stringify({ text: '对象形态' }))).toBe('对象形态');
    });

    it('falls back to raw string for malformed JSON that merely looks like JSON', () => {
        const malformed = '[未闭合的中括号开头，但其实是用户原话';
        expect(extractMessageText(malformed)).toBe(malformed);
    });

    it('drops blocks without text instead of rendering "undefined"', () => {
        const content = JSON.stringify([{ type: 'thinking' }, { type: 'text', text: '答案' }]);
        expect(extractMessageText(content)).toBe('答案');
    });
});

// 回归（cross-review critical）：GET /sessions/:id 的响应是 { success,
// session: { messages } } —— 第一版读了顶层 .messages，历史回填永远为空
// （"AI 记得、窗口失忆"）。这组测试钉死正确的响应形态。
describe('parseSessionHistory', () => {
    const wrap = (messages: unknown[]) => ({ success: true, session: { messages } });

    it('reads messages from payload.session.messages (NOT top-level)', () => {
        const payload = wrap([
            { id: 'm1', role: 'user', content: '你好' },
            { id: 'm2', role: 'assistant', content: '在的' },
        ]);
        const out = parseSessionHistory(payload, 50);
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ id: 'm1', role: 'user', text: '你好' });
        expect(out[1]).toMatchObject({ id: 'm2', role: 'ai', text: '在的' });
    });

    it('returns empty for the OLD (wrong) top-level shape instead of crashing', () => {
        const wrong = { messages: [{ id: 'm1', role: 'user', content: 'x' }] };
        expect(parseSessionHistory(wrong, 50)).toEqual([]);
    });

    it('filters non-chat roles, empty texts, and applies the tail limit', () => {
        const payload = wrap([
            { id: 's', role: 'system', content: 'sys' },
            { id: 'a', role: 'user', content: '1' },
            { id: 'b', role: 'assistant', content: JSON.stringify([{ type: 'tool_use' }]) },
            { id: 'c', role: 'user', content: '2' },
            { id: 'd', role: 'assistant', content: '3' },
        ]);
        const out = parseSessionHistory(payload, 2);
        expect(out.map((m) => m.text)).toEqual(['2', '3']);
    });

    it('tolerates null / malformed payloads', () => {
        expect(parseSessionHistory(null, 10)).toEqual([]);
        expect(parseSessionHistory({ session: {} }, 10)).toEqual([]);
        expect(parseSessionHistory({ session: { messages: 'nope' } }, 10)).toEqual([]);
    });
});
