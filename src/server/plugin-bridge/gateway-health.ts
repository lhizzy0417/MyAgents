export type GatewayRuntimeStatus = Record<string, unknown>;

export type GatewayHealthInput = {
  pluginLoaded: boolean;
  gatewayError: string | null;
  gatewayStarted: boolean;
  waitingForQrLogin: boolean;
  hasGateway: boolean;
  pluginName?: string;
  gatewayStatus?: GatewayRuntimeStatus | null;
  lastForwardAt?: number;
  nowMs?: number;
  stalenessMs?: number;
};

export type GatewayHealthResult = {
  status: number;
  body: Record<string, unknown>;
};

const DEFAULT_STALENESS_MS = 90_000;

function readyFailureReason(input: GatewayHealthInput): string {
  if (!input.pluginLoaded) return 'plugin-not-loaded';
  if (input.gatewayError) return 'gateway-error';
  return 'gateway-not-started';
}

function numericTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildReadyHealth(input: GatewayHealthInput): GatewayHealthResult {
  const ready = input.pluginLoaded
    && !input.gatewayError
    && (input.gatewayStarted || input.waitingForQrLogin);

  if (ready) {
    return {
      status: 200,
      body: {
        state: 'ready',
        pluginName: input.pluginName,
        waitingForQrLogin: input.waitingForQrLogin,
      },
    };
  }

  return {
    status: 503,
    body: {
      state: 'pending',
      reason: readyFailureReason(input),
      pluginName: input.pluginName,
      error: input.gatewayError || undefined,
      waitingForQrLogin: input.waitingForQrLogin,
    },
  };
}

export function buildFunctionalHealth(input: GatewayHealthInput): GatewayHealthResult {
  const ready = buildReadyHealth(input);
  if (ready.status !== 200) {
    return {
      status: 503,
      body: {
        state: 'unready',
        reason: ready.body.reason,
        error: input.gatewayError || undefined,
      },
    };
  }

  if (!input.hasGateway) {
    return { status: 200, body: { state: 'functional', reason: 'send-only' } };
  }

  if (input.waitingForQrLogin) {
    return { status: 200, body: { state: 'functional', reason: 'awaiting-qr-login' } };
  }

  const status = input.gatewayStatus;
  if (status?.running === false) {
    return {
      status: 503,
      body: {
        state: 'unfunctional',
        reason: 'gateway-stopped',
      },
    };
  }

  const nowMs = input.nowMs ?? Date.now();
  const stalenessMs = input.stalenessMs ?? DEFAULT_STALENESS_MS;
  const lastEventAt = numericTimestamp(status?.lastEventAt);
  if (lastEventAt !== null) {
    const gatewayStatusMsAgo = nowMs - lastEventAt;
    if (gatewayStatusMsAgo <= stalenessMs) {
      return {
        status: 200,
        body: {
          state: 'functional',
          reason: 'gateway-status',
          gatewayStatusMsAgo,
        },
      };
    }

    return {
      status: 503,
      body: {
        state: 'unfunctional',
        reason: 'gateway-status-stale',
        gatewayStatusMsAgo,
        message: `no successful gateway poll in the last ${stalenessMs}ms`,
      },
    };
  }

  const lastForward = numericTimestamp(input.lastForwardAt);
  const lastForwardMsAgo = lastForward !== null ? nowMs - lastForward : null;
  if (lastForwardMsAgo !== null && lastForwardMsAgo <= stalenessMs) {
    return {
      status: 200,
      body: {
        state: 'functional',
        reason: 'recent-forward',
        lastForwardMsAgo,
      },
    };
  }

  return {
    status: 200,
    body: {
      state: lastForwardMsAgo === null ? 'unknown' : 'stale',
      lastForwardMsAgo,
      message: `no successful forward in the last ${stalenessMs}ms`,
    },
  };
}
