import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import ContextMenu, { type ContextMenuItem } from './ContextMenu';

describe('ContextMenu', () => {
  it('renders item labels and fires onClick + onClose on an enabled item', async () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    const items: ContextMenuItem[] = [{ label: '引用文件', onClick }];
    render(<ContextMenu x={10} y={10} items={items} onClose={onClose} />);

    const item = screen.getByRole('button', { name: '引用文件' });
    expect(item).toBeInTheDocument();
    await userEvent.click(item);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick for a disabled item', async () => {
    const onClick = vi.fn();
    render(
      <ContextMenu x={0} y={0} items={[{ label: 'Delete', disabled: true, onClick }]} onClose={vi.fn()} />,
    );
    const item = screen.getByRole('button', { name: 'Delete' });
    expect(item).toBeDisabled();
    await userEvent.click(item).catch(() => { /* user-event refuses to click a disabled element */ });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders separators as non-button dividers', () => {
    const items: ContextMenuItem[] = [
      { label: 'A', onClick: vi.fn() },
      { separator: true },
      { label: 'B', onClick: vi.fn() },
    ];
    render(<ContextMenu x={0} y={0} items={items} onClose={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(2); // separator is not a button
  });
});
