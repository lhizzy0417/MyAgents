import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const repoRoot = process.cwd();

function listSourceFiles(relativeDir: string): string[] {
  const root = join(repoRoot, relativeDir);
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(relative(repoRoot, fullPath)));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

function sourceWithoutCommentLines(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('console.');
    })
    .join('\n');
}

describe('SessionEngine runtime boundary', () => {
  it('keeps Phase5 migrated route modules behind SessionEngine instead of direct builtin/external adapters', () => {
    const routeFiles = [
      'src/server/routes/session-read.ts',
      'src/server/routes/chat-stream.ts',
      'src/server/routes/session-config.ts',
      'src/server/routes/session-operations.ts',
    ].map(file => join(repoRoot, file));
    const forbidden = [
      '../agent-session',
      '../runtimes/external-session',
      'enqueueUserMessage(',
      'sendExternalMessage(',
      'waitForSessionIdle(',
      'waitForExternalSessionIdle(',
      'shouldUseExternalRuntime(',
      'didLastTurnSucceed(',
      'getAndClearLastAgentError(',
    ];

    const violations = routeFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbidden
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it('does not reintroduce route-level runtime selection in the monolithic server entrypoint', () => {
    const source = readFileSync(join(repoRoot, 'src/server/index.ts'), 'utf8');

    expect(source).not.toContain('shouldUseExternalRuntime(');
    expect(source).not.toContain('sendExternalMessage(');
    expect(source).not.toContain('enqueueUserMessage(');
    expect(source).not.toContain('waitForExternalSessionIdle(');
    expect(source).not.toContain('waitForSessionIdle(');
    expect(source).not.toContain('didLastTurnSucceed(');
    expect(source).not.toContain('getAndClearLastAgentError(');
  });

  it('keeps Phase6 builtin owner modules behind the agent-session facade', () => {
    const routeFiles = listSourceFiles('src/server/routes');
    const adapterFiles = listSourceFiles('src/server/session-engine');

    const violations = [...routeFiles, ...adapterFiles].flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes('../builtin-session/')
        || source.includes('./builtin-session/')
        || source.includes('src/server/builtin-session/')
        ? [`${relative(repoRoot, file)} imports builtin-session internals`]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps builtin owner modules independent from routes and SessionEngine', () => {
    const ownerFiles = listSourceFiles('src/server/builtin-session');

    const violations = ownerFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [
        '../agent-session',
        '../session-engine',
        './session-engine',
        '../routes',
        './routes',
      ]
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });

  it('keeps builtin owner writes behind owner APIs instead of mutable state bags', () => {
    const source = sourceWithoutCommentLines(join(repoRoot, 'src/server/agent-session.ts'));
    const forbidden = [
      /lifecycleState\.(?:messageResolver|query|processing|preWarming|preWarmFailCount|preWarmTimer|systemInitInfo|sdkControlReady|termination)\s*(?<!=)=(?!=)/,
      /queueState\.(?:messageQueue|pendingMidTurnQueue|turnBoundaryQueue|turnAdmissionTicket|inFlightToCliId|inFlightMetadata|forceSurfaceInFlightId|forceTurnBoundaryQueueId|promotedItemInFlight|awaitingAssistantStartAckQueueId|committingTurnAdmissionQueueId|interruptingInFlightQueueId)\s*(?<!=)=(?!=)/,
      /queueState\.(?:messageQueue|pendingMidTurnQueue|turnBoundaryQueue)\.(?:push|unshift|shift|splice)\(/,
      /turnState\.(?:injectedTurnOutcomes|discardedInjectedTurnIds)\.(?:set|delete|clear|add)\(/,
      /turnState\.(?:currentTurnInjectedTurnId|currentTurnImTerminalEmitted|currentPlanFileMinMtimeMs|currentTurnStartTime|currentTurnToolCount|sessionBrowserToolUsed|sessionStorageStateSaved|turnHadSubstantiveActivity|currentTurnCompactResult|currentTurnSawCompactBoundary|currentTurnHadAssistantMessageError|currentTurnLastAssistantMessageError|currentTurnHasOutput|latestMainAssistantUsage|currentTurnAnalyticsSource|currentTurnProviderAnalytics|currentTurnAssistantMessagePresent)\s*(?:(?<!=)=(?!=)|\+\+|--)/,
      /turnState\.currentTurnUsage\.[A-Za-z0-9_]+\s*(?<!=)=(?!=)/,
      /turnState\.pendingRequestIds\.(?:push|shift|splice)\(/,
      /turnState\.pendingRequestIds\.length\s*(?<!=)=(?!=)/,
      /turnState\.currentTurnTextBlocks\.(?:push|splice)\(/,
      /turnState\.currentTurnTextBlocks\.length\s*(?<!=)=(?!=)/,
      /turnState\.currentTurnInboxMeta\s*(?<!=)=(?!=)/,
      /configState\.(?:currentMcpServers|currentEnabledPluginIds|currentAgentDefinitions|currentPermissionMode|prePlanPermissionMode|currentBackgroundAgentPermissionMode|currentModel|currentReasoningEffort|currentProviderEnv|pendingProviderHistoryBoundaryReset|frozenSdkMcpFingerprint)\s*(?<!=)=(?!=)/,
      /transcriptState\.(?:messages|messageSequence|lastPersistedIndex|persistedSessionMessageCache|persistChainBySession|currentSessionUuids|liveSessionUuids|pendingReloadAnchor)\s*(?:(?<!=)=(?!=)|\+\+|--)/,
      /transcriptState\.(?:messages|persistedSessionMessageCache)\.length\s*(?<!=)=(?!=)/,
      /transcriptState\.(?:messages|persistedSessionMessageCache|persistChainBySession|currentSessionUuids|liveSessionUuids)\.(?:push|splice|add|delete|clear)\(/,
    ];
    const violations = forbidden
      .filter(pattern => pattern.test(source))
      .map(pattern => String(pattern));

    expect(violations).toEqual([]);
  });

  it('keeps Phase7 turn terminal and transcript persistence behavior out of the facade', () => {
    const facade = sourceWithoutCommentLines(join(repoRoot, 'src/server/agent-session.ts'));
    const turnLifecycle = sourceWithoutCommentLines(join(repoRoot, 'src/server/builtin-session/turn-lifecycle.ts'));
    const transcriptPersistence = sourceWithoutCommentLines(join(repoRoot, 'src/server/builtin-session/transcript-persistence.ts'));
    const forbiddenFacadePatterns = [
      /\bextractTurnUsageFromSdkResult\b/,
      /\bisEmptySuccessfulSdkResult\b/,
      /\bisSuccessfulCompactControlTurn\b/,
      /\bisRecoveredAssistantMessageError\b/,
      /\bfindTurnUsageStampIndex\b/,
      /\bresolveLastRealUserMessagePreview\b/,
      /\bseedBridgeThoughtSignatures\b/,
      /\blastTurnEndPersist\b/,
      /\bsaveSessionMessages\b/,
      /\b(?:function|const|let|var)\s+(?:schedulePersist|doPersistMessagesToStorage|loadMessagesFromStorage)\b/,
    ];

    expect(facade).toContain('builtinTurnLifecycle.handleSdkResult');
    expect(forbiddenFacadePatterns.filter(pattern => pattern.test(facade)).map(String)).toEqual([]);
    expect(facade).toContain('saveForkTranscript');

    expect(turnLifecycle).toContain('extractTurnUsageFromSdkResult');
    expect(turnLifecycle).toContain('isEmptySuccessfulSdkResult');
    expect(turnLifecycle).toContain('lastTurnEndPersist');
    expect(turnLifecycle).toContain('stampTurnUsageOnPendingAssistant');
    expect(transcriptPersistence).toContain('saveSessionMessages');
    expect(transcriptPersistence).toContain('saveForkTranscript');
    expect(transcriptPersistence).toContain('scheduleTranscriptPersist');
    expect(transcriptPersistence).toContain('loadTranscriptFromSessionMessages');
  });

  it('keeps session-core pure and side-effect free', () => {
    const coreFiles = [
      'src/server/session-core/turn-result-policy.ts',
      'src/server/session-core/runtime-config-policy.ts',
      'src/server/session-core/turn-queue.ts',
      'src/server/session-core/mcp-sync-policy.ts',
    ].map(file => join(repoRoot, file));
    const forbidden = [
      '../agent-session',
      '../builtin-session',
      '../sse',
      '../SessionStore',
      'broadcast(',
      '@anthropic-ai/claude-agent-sdk',
      'readFileSync',
      'writeFileSync',
      'appendFileSync',
    ];

    const violations = coreFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return forbidden
        .filter(pattern => source.includes(pattern))
        .map(pattern => `${relative(repoRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });
});
