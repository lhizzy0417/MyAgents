import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));

import Message from './Message';

function userMsg(content: string): MessageType {
  return {
    id: 'u1',
    role: 'user',
    content,
    timestamp: new Date(),
  } as MessageType;
}

describe('Message — user bubble spacing', () => {
  it('uses equal bubble padding and scopes Markdown paragraph margins', () => {
    const { container } = render(<Message message={userMsg('你可以帮我写个 v3')} />);

    const bubble = container.querySelector('article');
    expect(bubble).toHaveClass('p-4');
    expect(bubble).not.toHaveClass('py-3');

    const content = container.querySelector('.user-message-content');
    expect(content).toBeInTheDocument();
    expect(content?.querySelector('p')).toHaveTextContent('你可以帮我写个 v3');
  });
});
