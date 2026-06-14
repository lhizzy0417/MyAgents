import { invoke } from '@tauri-apps/api/core';

import { isTauriEnvironment } from '@/utils/browserMock';

interface FbCapabilities {
    supported: boolean;
    active: boolean;
}

export function describeNativeFloatingBallError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export async function setNativeFloatingBallEnabled(enabled: boolean): Promise<void> {
    if (!isTauriEnvironment()) return;

    if (enabled) {
        const capabilities = await invoke<FbCapabilities>('cmd_fb_capabilities');
        if (!capabilities.supported) {
            throw new Error('当前系统暂不支持桌面宠物');
        }
        await invoke('cmd_fb_enable');
        return;
    }

    await invoke('cmd_fb_disable');
}
