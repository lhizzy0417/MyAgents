import { useEffect, useState } from 'react';
import { spaceGetCapability, type SpaceBuildCapability } from '@/api/spaceCloud';
import { isTauriEnvironment } from '@/utils/browserMock';

export interface SpaceBuildCapabilityState extends SpaceBuildCapability {
  isLoading: boolean;
}

const LOADING_SPACE_CAPABILITY: SpaceBuildCapabilityState = {
  available: false,
  baseUrl: null,
  publicClientId: null,
  reason: null,
  isLoading: true,
};

const UNAVAILABLE_SPACE_CAPABILITY: SpaceBuildCapabilityState = {
  available: false,
  baseUrl: null,
  publicClientId: null,
  reason: 'Team Space requires a Tauri build with MYAGENTS_SPACE_ENABLED=true',
  isLoading: false,
};

export function useSpaceBuildCapability(): SpaceBuildCapabilityState {
  const [capability, setCapability] = useState<SpaceBuildCapabilityState>(() => (
    isTauriEnvironment() ? LOADING_SPACE_CAPABILITY : UNAVAILABLE_SPACE_CAPABILITY
  ));

  useEffect(() => {
    let cancelled = false;
    if (!isTauriEnvironment()) {
      return () => {
        cancelled = true;
      };
    }

    spaceGetCapability()
      .then((next) => {
        if (!cancelled) setCapability({ ...next, isLoading: false });
      })
      .catch((error) => {
        if (cancelled) return;
        setCapability({
          ...UNAVAILABLE_SPACE_CAPABILITY,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return capability;
}
