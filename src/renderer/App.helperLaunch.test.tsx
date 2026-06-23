import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CUSTOM_EVENTS } from '../shared/constants';

const mocks = vi.hoisted(() => {
  const project = {
    id: 'helper-project',
    path: '/Users/me/.myagents',
    displayName: 'MA Helper',
    agentId: 'helper-agent',
  };
  const agent = {
    id: 'helper-agent',
    name: 'MA Helper',
    workspacePath: project.path,
    runtime: 'builtin',
  };
  const provider = {
    id: 'provider-1',
    name: 'Provider',
    type: 'openai-compatible',
    baseUrl: 'https://example.com',
    primaryModel: 'mimo-v2.5-pro',
    models: [{ id: 'mimo-v2.5-pro', name: 'mimo-v2.5-pro' }],
  };

  return {
    project,
    agent,
    provider,
    startGlobalSidecar: vi.fn(async () => undefined),
    initGlobalSidecarReadyPromise: vi.fn(),
    markGlobalSidecarReady: vi.fn(),
    getGlobalServerUrl: vi.fn(async () => 'http://127.0.0.1:31415'),
    ensureSessionSidecar: vi.fn(async () => ({ port: 31417, isNew: true })),
    activateSession: vi.fn(async () => undefined),
    releaseSessionSidecar: vi.fn(async () => false),
    deactivateSession: vi.fn(async () => undefined),
    getSessionPort: vi.fn(async () => null),
    startBackgroundCompletion: vi.fn(async () => ({ started: false })),
    setAppActiveCorrelation: vi.fn(),
    setAppActiveTabId: vi.fn(),
    chatProps: [] as Array<Record<string, unknown>>,
  };
});

vi.mock('@/analytics', () => ({
  initAnalytics: vi.fn(async () => undefined),
  track: vi.fn(),
  setAnalyticsContext: vi.fn(),
  clearAnalyticsContext: vi.fn(),
  setPendingSurface: vi.fn(),
  clearPendingSurface: vi.fn(),
  setPendingSessionBirth: vi.fn(),
  clearPendingSessionBirth: vi.fn(),
  birthContextForSurface: vi.fn((surface: string) => ({
    surface,
    entryIntent: surface === 'new_chat_button' ? 'new_chat' : 'unknown',
    hasInitialMessage: surface !== 'new_chat_button',
  })),
  hashAgentName: vi.fn(async () => 'agent-hash'),
  hashAgentNameSync: vi.fn(() => 'agent-hash'),
}));

vi.mock('@/api/tauriClient', () => ({
  stopTabSidecar: vi.fn(async () => undefined),
  setAppActiveCorrelation: mocks.setAppActiveCorrelation,
  startGlobalSidecar: mocks.startGlobalSidecar,
  initGlobalSidecarReadyPromise: mocks.initGlobalSidecarReadyPromise,
  markGlobalSidecarReady: mocks.markGlobalSidecarReady,
  getGlobalServerUrl: mocks.getGlobalServerUrl,
  getSessionActivation: vi.fn(async () => null),
  updateSessionTab: vi.fn(async () => undefined),
  ensureSessionSidecar: mocks.ensureSessionSidecar,
  releaseSessionSidecar: mocks.releaseSessionSidecar,
  activateSession: mocks.activateSession,
  deactivateSession: mocks.deactivateSession,
  upgradeSessionId: vi.fn(async () => true),
  getSessionPort: mocks.getSessionPort,
  hasSessionSidecar: vi.fn(async () => true),
  getSessionGeneration: vi.fn(async () => 1),
  stopSseProxy: vi.fn(async () => undefined),
  startBackgroundCompletion: mocks.startBackgroundCompletion,
  cancelBackgroundCompletion: vi.fn(async () => undefined),
  updateGlobalServerUrl: vi.fn(),
  canRestoreSession: vi.fn(async () => true),
}));

vi.mock('@/api/apiFetch', () => ({
  apiGetJson: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/api/cronTaskClient', () => ({
  getAllCronTasks: vi.fn(async () => []),
  getTabCronTask: vi.fn(async () => null),
  updateCronTaskTab: vi.fn(async () => undefined),
}));

vi.mock('@/api/sessionClient', () => ({
  updateSession: vi.fn(async () => undefined),
}));

vi.mock('@/components/ChatBootOverlay', () => ({
  default: () => <div data-testid="chat-boot-overlay" />,
}));

vi.mock('@/components/ConfirmDialog', () => ({
  default: () => <div data-testid="confirm-dialog" />,
}));

vi.mock('@/components/BugReportOverlay', () => ({
  default: () => <div data-testid="bug-report-overlay" />,
}));

vi.mock('@/components/CustomTitleBar', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="titlebar">{children}</div>,
}));

vi.mock('@/components/LinkContextMenuProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/TabBar', () => ({
  default: ({ tabs, activeTabId }: { tabs: Array<{ id: string; title: string }>; activeTabId: string | null }) => (
    <div data-testid="tabbar-active">{tabs.find(t => t.id === activeTabId)?.title ?? 'missing'}</div>
  ),
}));

vi.mock('@/context/TabProvider', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div data-testid="tab-provider">{children}</div>,
}));

vi.mock('@/pages/Chat', () => ({
  default: (props: Record<string, unknown>) => {
    mocks.chatProps.push(props);
    return <div data-testid="chat-page" />;
  },
}));

vi.mock('@/pages/Launcher', () => ({
  default: () => <div data-testid="launcher-page" />,
}));

vi.mock('@/pages/Settings', () => ({
  default: () => <div data-testid="settings-page" />,
}));

vi.mock('@/pages/TaskCenter', () => ({
  default: () => <div data-testid="taskcenter-page" />,
}));

vi.mock('@/components/Toast', () => ({
  useToast: () => ({
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }),
}));

vi.mock('@/hooks/useUpdater', () => ({
  useUpdater: () => ({
    updateReady: false,
    updateVersion: null,
    updateChecking: false,
    updateDownloading: false,
    updateInstalling: false,
    updatePreparing: false,
    pendingUpdateOnStartup: null,
    dismissPendingUpdate: vi.fn(),
    checkForUpdate: vi.fn(async () => 'up-to-date'),
    restartAndUpdate: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTrayEvents', () => ({
  useTrayEvents: vi.fn(),
}));

vi.mock('@/hooks/useHelperAgentModelDefaults', () => ({
  useHelperAgentModelDefaults: () => ({
    providerId: mocks.provider.id,
    model: 'mimo-v2.5-pro',
    setDefaults: vi.fn(),
  }),
}));

vi.mock('@/hooks/useConfig', () => ({
  useConfig: () => ({
    config: {
      projects: [mocks.project],
      agents: [mocks.agent],
      multiAgentRuntime: false,
      defaultPermissionMode: 'auto',
    },
    isLoading: false,
    error: null,
    projects: [mocks.project],
    providers: [mocks.provider],
    apiKeys: { [mocks.provider.id]: 'key' },
    providerVerifyStatus: { [mocks.provider.id]: { status: 'valid' } },
    addProject: vi.fn(async () => mocks.project),
    updateProject: vi.fn(async () => undefined),
    patchProject: vi.fn(async () => undefined),
    removeProject: vi.fn(async () => undefined),
    touchProject: vi.fn(async () => undefined),
    addCustomProvider: vi.fn(async () => undefined),
    updateCustomProvider: vi.fn(async () => undefined),
    deleteCustomProvider: vi.fn(async () => undefined),
    refreshProviders: vi.fn(async () => undefined),
    savePresetCustomModels: vi.fn(async () => undefined),
    removePresetCustomModel: vi.fn(async () => undefined),
    savePrimaryModel: vi.fn(async () => undefined),
    saveProviderModelAliases: vi.fn(async () => undefined),
    saveApiKey: vi.fn(async () => undefined),
    deleteApiKey: vi.fn(async () => undefined),
    saveProviderVerifyStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => undefined),
    patchProxySettings: vi.fn(async () => undefined),
    refreshConfig: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    refreshProviderData: vi.fn(async () => undefined),
  }),
}));

vi.mock('@/hooks/useTheme', () => ({
  useThemeEffect: vi.fn(),
}));

vi.mock('@/hooks/useTabSwipeGesture', () => ({
  useTabSwipeGesture: vi.fn(),
}));

vi.mock('@/utils/browserMock', () => ({
  isBrowserDevMode: () => false,
  isTauriEnvironment: () => false,
}));

vi.mock('@/utils/frontendLogger', () => ({
  forceFlushLogs: vi.fn(async () => undefined),
  setLogServerUrl: vi.fn(),
  clearLogServerUrl: vi.fn(),
  setAppActiveTabId: mocks.setAppActiveTabId,
}));

vi.mock('@/utils/lastExitMarker', () => ({
  consumeCleanExitMarker: vi.fn(async () => true),
}));

vi.mock('@/utils/tabPersistenceDurable', () => ({
  persistOpenTabsDurable: vi.fn(async () => undefined),
  loadAndClearOpenTabsDurable: vi.fn(async () => null),
  clearOpenTabsDurable: vi.fn(async () => undefined),
}));

vi.mock('@/utils/tauriListen', () => ({
  listenWithCleanup: vi.fn(async () => undefined),
}));

vi.mock('@/config/configService', () => ({
  ensureSelfAwarenessWorkspace: vi.fn(async () => mocks.project),
  resolveBuiltinSelection: vi.fn(() => ({ provider: mocks.provider, model: 'mimo-v2.5-pro' })),
  pairBuiltinSelection: vi.fn((_provider, model) => ({ providerId: mocks.provider.id, model })),
  isProviderAvailable: vi.fn(() => true),
}));

vi.mock('@/config/services/agentConfigService', () => ({
  getAgentByWorkspacePath: vi.fn(() => mocks.agent),
  getAgentById: vi.fn(() => mocks.agent),
}));

import App from './App';

describe('App helper launch', () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.chatProps.length = 0;
  });

  it('commits the helper tab before launching so the active tab is renderable', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            description: 'help',
            providerId: mocks.provider.id,
            model: 'mimo-v2.5-pro',
            appVersion: 'test',
            images: [],
          },
        }));
      });

      await waitFor(() => expect(mocks.ensureSessionSidecar).toHaveBeenCalled());

      const launchStart = logSpy.mock.calls
        .map(call => String(call[0]))
        .find(message => message.includes('[App][launch] START'));

      expect(launchStart).toContain('view=launcher');
      expect(launchStart).not.toContain('view=undefined');
      expect(mocks.setAppActiveTabId).toHaveBeenCalledWith(
        expect.stringMatching(/^tab-/),
        expect.arrayContaining([expect.stringMatching(/^tab-/)]),
      );
      expect(mocks.setAppActiveCorrelation).toHaveBeenCalledWith(expect.objectContaining({
        tabId: expect.stringMatching(/^tab-/),
      }));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('releases the fork tab owner when fork tab activation fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      render(<App />);

      await act(async () => {
        window.dispatchEvent(new CustomEvent(CUSTOM_EVENTS.LAUNCH_BUG_REPORT, {
          detail: {
            description: 'help',
            providerId: mocks.provider.id,
            model: 'mimo-v2.5-pro',
            appVersion: 'test',
            images: [],
          },
        }));
      });

      await waitFor(() => {
        expect(mocks.chatProps.some((props) => typeof props.onForkSession === 'function')).toBe(true);
      });

      mocks.activateSession.mockRejectedValueOnce(new Error('activate failed'));
      const chatProps = [...mocks.chatProps]
        .reverse()
        .find((props) => typeof props.onForkSession === 'function') as {
          onForkSession: (sessionId: string, agentDir: string, title: string) => Promise<boolean>;
        };

      let opened = true;
      await act(async () => {
        opened = await chatProps.onForkSession('fork-session', mocks.project.path, 'Fork');
      });

      expect(opened).toBe(false);
      expect(mocks.ensureSessionSidecar).toHaveBeenCalledWith(
        'fork-session',
        mocks.project.path,
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.releaseSessionSidecar).toHaveBeenCalledWith(
        'fork-session',
        'tab',
        expect.stringMatching(/^tab-/),
      );
      expect(mocks.deactivateSession).toHaveBeenCalledWith('fork-session');
    } finally {
      errorSpy.mockRestore();
    }
  });
});
