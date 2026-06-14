import type { RuntimeType } from '../../shared/types/runtime';
import type { SessionMetadata } from '../types/session';

export type SdkTranscriptProbe = (
  sessionId: string,
  options: { dir: string; limit: 1 },
) => Promise<readonly unknown[]>;

export type BuiltinSessionResumeDecision =
  | {
      shouldResume: true;
      resumeSessionId: string;
      reason: 'sdk-session-id' | 'unified-transcript';
    }
  | {
      shouldResume: false;
      reason:
        | 'runtime-mismatch'
        | 'external-runtime'
        | 'no-sdk-marker'
        | 'no-sdk-transcript'
        | 'probe-error';
      error?: unknown;
    };

/**
 * MyAgents metadata is not proof that the Claude Agent SDK can resume.
 * `query({ resume })` needs an SDK transcript under the same cwd; metadata-only
 * sessions created by POST /sessions must start with `sessionId` instead.
 */
export async function decideBuiltinSessionResume(params: {
  meta: SessionMetadata;
  currentRuntime: RuntimeType;
  agentDir: string;
  probeSdkTranscript: SdkTranscriptProbe;
}): Promise<BuiltinSessionResumeDecision> {
  const metaRuntime = params.meta.runtime ?? 'builtin';
  if (metaRuntime !== params.currentRuntime) {
    return { shouldResume: false, reason: 'runtime-mismatch' };
  }

  if (params.currentRuntime !== 'builtin') {
    return { shouldResume: false, reason: 'external-runtime' };
  }

  if (params.meta.sdkSessionId) {
    return {
      shouldResume: true,
      resumeSessionId: params.meta.sdkSessionId,
      reason: 'sdk-session-id',
    };
  }

  if (!params.meta.unifiedSession) {
    return { shouldResume: false, reason: 'no-sdk-marker' };
  }

  try {
    const messages = await params.probeSdkTranscript(params.meta.id, {
      dir: params.agentDir,
      limit: 1,
    });
    if (messages.length > 0) {
      return {
        shouldResume: true,
        resumeSessionId: params.meta.id,
        reason: 'unified-transcript',
      };
    }
    return { shouldResume: false, reason: 'no-sdk-transcript' };
  } catch (error) {
    return { shouldResume: false, reason: 'probe-error', error };
  }
}
