import { describe, expect, it } from 'vitest';

import { buildFunctionalHealth, buildReadyHealth } from './gateway-health';

const baseInput = {
  pluginLoaded: true,
  gatewayError: null,
  gatewayStarted: true,
  waitingForQrLogin: false,
  hasGateway: true,
  nowMs: 1_000_000,
  stalenessMs: 90_000,
};

describe('plugin bridge gateway health', () => {
  it('reports ready when the plugin loaded and gateway was started', () => {
    expect(buildReadyHealth(baseInput)).toMatchObject({
      status: 200,
      body: { state: 'ready' },
    });
  });

  it('reports stale plugin gateway status as unfunctional', () => {
    expect(buildFunctionalHealth({
      ...baseInput,
      gatewayStatus: { running: true, lastEventAt: 800_000 },
    })).toMatchObject({
      status: 503,
      body: {
        state: 'unfunctional',
        reason: 'gateway-status-stale',
      },
    });
  });

  it('keeps quiet plugins with no status in unknown state instead of failing', () => {
    expect(buildFunctionalHealth(baseInput)).toMatchObject({
      status: 200,
      body: { state: 'unknown' },
    });
  });

  it('reports stopped plugin gateway status as unfunctional', () => {
    expect(buildFunctionalHealth({
      ...baseInput,
      gatewayStatus: { running: false },
    })).toMatchObject({
      status: 503,
      body: {
        state: 'unfunctional',
        reason: 'gateway-stopped',
      },
    });
  });

  it('accepts recent plugin gateway status as functional', () => {
    expect(buildFunctionalHealth({
      ...baseInput,
      gatewayStatus: { running: true, lastEventAt: 950_000 },
    })).toMatchObject({
      status: 200,
      body: {
        state: 'functional',
        reason: 'gateway-status',
      },
    });
  });

  it('does not fail while the plugin is waiting for QR login', () => {
    expect(buildFunctionalHealth({
      ...baseInput,
      gatewayStarted: false,
      waitingForQrLogin: true,
      gatewayStatus: { running: false },
    })).toMatchObject({
      status: 200,
      body: {
        state: 'functional',
        reason: 'awaiting-qr-login',
      },
    });
  });
});
