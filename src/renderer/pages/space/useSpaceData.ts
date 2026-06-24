import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  actions,
  getSnapshot,
  subscribe,
  SPACE_VISIBLE_REFRESH_TTL_MS,
  type SpaceDataSnapshot,
} from './spaceStore';

export interface UseSpaceDataOptions {
  isActive?: boolean;
}

export function useSpaceData({ isActive }: UseSpaceDataOptions): SpaceDataSnapshot {
  const data = useSyncExternalStore(subscribe, getSnapshot);
  const prevActiveRef = useRef(isActive);

  useEffect(() => {
    const wasInactive = !prevActiveRef.current;
    prevActiveRef.current = isActive;
    if (wasInactive && isActive) {
      void actions.ensureBootstrapped({ silent: true, maxAgeMs: SPACE_VISIBLE_REFRESH_TTL_MS });
    }
  }, [isActive]);

  return data;
}
