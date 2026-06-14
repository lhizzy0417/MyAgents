import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ToolAttachment } from '@/types/chat';
import ToolImageAttachment from './ToolImageAttachment';

vi.mock('@/context/TabContext', () => ({
  useTabStateOptional: () => ({ sessionId: 'session-a' }),
}));

vi.mock('@/utils/toolAttachment', () => ({
  useAttachmentUrl: () => ({ state: 'ready', url: 'data:image/png;base64,abc' }),
}));

const attachment: ToolAttachment = {
  kind: 'image',
  mimeType: 'image/png',
  refPath: '/api/attachment/tool/session-a/turn-a/image.png',
  caption: 'Generated reference image',
};

describe('ToolImageAttachment', () => {
  it('wraps the clickable image shell around the rendered image instead of a wider fixed shell', () => {
    const { container } = render(<ToolImageAttachment attachment={attachment} />);

    const shell = screen.getByRole('button');
    expect(shell).toHaveClass('inline-flex', 'max-w-full');
    expect(shell).not.toHaveClass('block', 'max-w-sm');

    const image = screen.getByRole('img');
    expect(image).toHaveClass('max-h-80', 'max-w-full', 'h-auto', 'object-contain');
    expect(image).not.toHaveClass('w-auto');

    const stack = container.firstElementChild;
    expect(stack).toHaveClass('items-start', 'max-w-full');
  });
});
