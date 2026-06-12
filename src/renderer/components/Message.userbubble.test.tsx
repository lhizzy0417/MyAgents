import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Message as MessageType } from '@/types/chat';

vi.mock('@/context/ImagePreviewContext', () => ({ useImagePreview: () => ({ openPreview: vi.fn() }) }));
vi.mock('@/analytics', () => ({ track: vi.fn() }));

import Message from './Message';

function userMsg(
  content: string,
  overrides: Partial<MessageType> = {}
): MessageType {
  return {
    id: 'u1',
    role: 'user',
    content,
    timestamp: new Date(),
    ...overrides,
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

  it('renders sent image attachments as fixed-height ratio-preserving previews', () => {
    const { container } = render(
      <Message
        message={userMsg('能看到我的屏幕嘛', {
          attachments: [
            {
              id: 'att-1',
              name: 'wide-terminal.png',
              size: 42_000,
              mimeType: 'image/png',
              previewUrl: 'data:image/png;base64,abc',
              isImage: true,
            },
          ],
        })}
      />
    );

    const image = container.querySelector('img[alt="wide-terminal.png"]');
    expect(image).toHaveClass('h-full', 'w-auto', 'object-contain');
    expect(image).not.toHaveClass('object-cover');

    const attachmentStrip = image?.closest('.flex-nowrap');
    expect(attachmentStrip).toBeInTheDocument();
    expect(attachmentStrip).not.toHaveClass('grid-cols-5');
  });
});
