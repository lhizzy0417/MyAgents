export type BuiltinInjectedTurnTerminal =
  | {
      status: 'complete';
      assistantMessagePresent: boolean;
      text: string;
      error?: string;
    }
  | {
      status: 'stopped' | 'error';
      assistantMessagePresent: boolean;
      text: string;
      error?: string;
    };

export type InjectedTurnDecision = {
  success: boolean;
  assistantMessagePresent?: boolean;
  text?: string;
  error?: string;
  status?: number;
};

export function decideBuiltinInjectedTurnResult(params: {
  idleCompleted: boolean;
  outcome?: BuiltinInjectedTurnTerminal;
}): InjectedTurnDecision {
  if (!params.idleCompleted) {
    return { success: false, error: 'Execution timed out', status: 408 };
  }
  if (!params.outcome) {
    return {
      success: false,
      error: 'Injected turn finished without a recorded outcome',
      status: 503,
    };
  }
  if (params.outcome.status !== 'complete') {
    return {
      success: false,
      error: params.outcome.error ?? `Injected turn ${params.outcome.status}`,
      status: 503,
    };
  }
  return {
    success: true,
    assistantMessagePresent: params.outcome.assistantMessagePresent,
    text: params.outcome.text,
  };
}

export function decideExternalInjectedTurnResult(params: {
  idleCompleted: boolean;
  turnSucceeded?: boolean;
  text?: string;
}): InjectedTurnDecision {
  if (!params.idleCompleted) {
    return { success: false, error: 'Execution timed out', status: 408 };
  }
  if (!params.turnSucceeded) {
    return {
      success: false,
      error: 'External runtime turn failed',
      status: 503,
    };
  }
  return { success: true, text: params.text };
}
