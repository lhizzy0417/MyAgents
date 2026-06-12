/**
 * AddWorkspaceMenu — dropdown menu for workspace "Add" button
 * Two options: add local folder, create from template
 */

import { memo, useCallback, useRef, useState } from 'react';
import { Plus, FolderPlus, LayoutTemplate } from 'lucide-react';

import { Popover } from '@/components/ui/Popover';

interface AddWorkspaceMenuProps {
    onAddFolder: () => void;
    onCreateFromTemplate: () => void;
}

export default memo(function AddWorkspaceMenu({
    onAddFolder,
    onCreateFromTemplate,
}: AddWorkspaceMenuProps) {
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const toggle = useCallback(() => setOpen(prev => !prev), []);

    return (
        <>
            <button
                ref={buttonRef}
                onClick={toggle}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--button-primary-bg)] px-2.5 py-1.5 text-sm font-medium text-[var(--button-primary-text)] transition-colors hover:bg-[var(--button-primary-bg-hover)]"
            >
                <Plus className="h-3.5 w-3.5" />
                添加
            </button>
            <Popover
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={buttonRef}
                placement="bottom-end"
                className="w-[180px] py-1"
            >
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onAddFolder(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                >
                    <FolderPlus className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    添加本地文件夹
                </button>
                <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setOpen(false); onCreateFromTemplate(); }}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--ink)] transition-colors hover:bg-[var(--hover-bg)]"
                >
                    <LayoutTemplate className="h-3.5 w-3.5 text-[var(--ink-muted)]" />
                    从模板创建 Agent
                </button>
            </Popover>
        </>
    );
});
