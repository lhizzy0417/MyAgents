/**
 * 回归不变量：聊天 assistant 正文容器 MUST 携带 `ai-message-content`。
 *
 * 背景（PRD 0.2.34 Part 2）：该 CSS 类自诞生起是死代码——index.css 定义了
 * 16px/1.7/0.01em 的 prose 上下文、DESIGN.md §10 也如此宣称，但 Message.tsx
 * 从未引用它，聊天正文实际靠 UA 默认 16px + 段落 leading-relaxed 渲染，
 * "宣称的 1.7 行高"从未上屏。两轮扫描 + 一轮 cross-review 都没发现，因为
 * 大家只验了"CSS 值与文档一致"，没验"选择器是否命中元素"。
 *
 * 本测试把接线本身固化为不变量：下次重构 Message.tsx 时该类再静默脱落，
 * 这里会先红。覆盖 string 与 ContentBlock[] 两个 assistant 分支（第三个
 * widget-segment 分支共享同一容器 class 字符串，但 mount WidgetRenderer
 * 需要 iframe/postMessage 桩，不值得为同一断言引入；见 Message.tsx
 * renderWidgetSegments 的文本段容器）。
 */
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/context/ImagePreviewContext', () => ({
    useImagePreview: () => ({ openPreview: vi.fn() }),
}));

vi.mock('@/hooks/useWorkspaceFileService', () => ({
    useWorkspaceFileService: () => ({
        isAvailable: false,
        checkPaths: vi.fn(),
        checkLocalPaths: vi.fn(),
        openWithDefault: vi.fn(),
        openPathWithDefault: vi.fn(),
        openPathExternal: vi.fn(),
        openInFinder: vi.fn(),
        readPreview: vi.fn(),
        readLocalPreview: vi.fn(),
        readFileAsBlobUrl: vi.fn(),
        readLocalFileAsBlobUrl: vi.fn(),
    }),
}));

vi.mock('@/analytics', () => ({ track: vi.fn() }));

import Message from '@/components/Message';
import type { Message as MessageType } from '@/types/chat';

function assistantMessage(content: MessageType['content']): MessageType {
    return {
        id: 'm-prose-test',
        role: 'assistant',
        content,
        timestamp: new Date('2026-06-12T00:00:00Z'),
    };
}

describe('assistant 正文 prose 上下文接线（ai-message-content）', () => {
    it('string 分支容器携带 ai-message-content', () => {
        const { container } = render(
            <Message message={assistantMessage('你好，这是一段 AI 回复。')} />
        );
        const prose = container.querySelector('.ai-message-content');
        expect(prose).not.toBeNull();
        expect(prose!.textContent).toContain('这是一段 AI 回复');
    });

    it('ContentBlock[] 分支的文本块容器携带 ai-message-content', () => {
        const { container } = render(
            <Message
                message={assistantMessage([
                    { type: 'text', text: '块模式下的 AI 回复文本。' },
                ] as MessageType['content'])}
            />
        );
        const prose = container.querySelector('.ai-message-content');
        expect(prose).not.toBeNull();
        expect(prose!.textContent).toContain('块模式下的 AI 回复文本');
    });
});
