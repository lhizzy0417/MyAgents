import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImagePreviewProvider } from '@/context/ImagePreviewContext';

import SimpleChatInput from './SimpleChatInput';
import { ToastProvider } from './Toast';

function renderInput(onSend = vi.fn()) {
  render(
    <ToastProvider>
      <ImagePreviewProvider>
        <SimpleChatInput
          mode="launcher"
          runtime="codex"
          isLoading={false}
          onSend={onSend}
        />
      </ImagePreviewProvider>
    </ToastProvider>,
  );
  return onSend;
}

describe('SimpleChatInput IME submission guard', () => {
  it('does not send from the button while IME composition is active', () => {
    const onSend = renderInput();
    const textarea = screen.getByPlaceholderText('今天，想干点啥？');

    fireEvent.change(textarea, { target: { value: '输入法提交测试' } });
    fireEvent.compositionStart(textarea);
    fireEvent.click(screen.getByTitle('发送'));

    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.click(screen.getByTitle('发送'));

    expect(onSend).toHaveBeenCalledWith('输入法提交测试', undefined);
  });
});
