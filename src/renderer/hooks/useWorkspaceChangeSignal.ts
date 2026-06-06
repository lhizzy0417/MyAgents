import { useEffect, useState } from 'react';

import { listenWithCleanup } from '@/utils/tauriListen';
import { useWorkspaceFileService } from './useWorkspaceFileService';

/**
 * Ref-counted workspace filesystem change signal.
 *
 * Rust emits a coarse `workspace:files-changed:<eventKey>` event. Consumers
 * decide what to revalidate: DirectoryPanel refreshes the tree, FilePreviewModal
 * re-reads only the currently open file.
 */
export function useWorkspaceChangeSignal(
  workspacePath: string | null,
  enabled = true,
): number {
  const fileService = useWorkspaceFileService(workspacePath);
  const [signal, setSignal] = useState(0);

  useEffect(() => {
    if (!enabled || !fileService.isAvailable) return;

    const ac = new AbortController();
    let mounted = true;
    let token: string | null = null;

    (async () => {
      try {
        const handle = await fileService.watchStart();
        if (ac.signal.aborted) {
          await fileService.watchStop({ token: handle.token }).catch(() => {});
          return;
        }
        token = handle.token;
        await listenWithCleanup(`workspace:files-changed:${handle.eventKey}`, () => {
          if (mounted) setSignal((prev) => prev + 1);
        }, ac.signal);
      } catch (err) {
        console.warn('[useWorkspaceChangeSignal] watch start failed:', err);
      }
    })();

    return () => {
      mounted = false;
      ac.abort();
      if (token) {
        fileService.watchStop({ token }).catch(() => {});
      }
    };
  }, [enabled, fileService]);

  return signal;
}
