import type { Project } from '@/config/types';
import { workspacePathsEqual } from '@/../shared/workspacePath';

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function inv<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error(`MyAgents Space requires Tauri runtime: ${cmd}`);
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export interface SpaceUser {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export interface SpaceInfo {
  id: string;
  slug: string;
  name: string;
  joinPolicy: string;
}

export interface SpaceMembership {
  id: string;
  role: 'owner' | 'admin' | 'member';
}

export interface SpaceSession {
  baseUrl: string;
  expiresAt?: string | null;
  user: SpaceUser;
  space: SpaceInfo;
  membership: SpaceMembership;
  updatedAt: string;
}

export interface SpaceBuildCapability {
  available: boolean;
  baseUrl?: string | null;
  publicClientId?: string | null;
  reason?: string | null;
}

export interface SpaceTag {
  id: string;
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface SpaceIssue {
  id: string;
  spaceId: string;
  title: string;
  body: string;
  status: string;
  author?: { id: string; name?: string | null };
  tags?: SpaceTag[];
  commentCount?: number;
  attachmentCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceIssueComment {
  id: string;
  author: { id: string; type: 'user' | 'registered_agent' | 'system' };
  body: string;
  createdAt: string;
}

export interface SpaceAttachment {
  id: string;
  name: string;
  sizeBytes: number;
  mimeType?: string | null;
  createdAt: string;
}

export interface SpaceIssueDetail {
  issue: SpaceIssue;
  comments: {
    items: SpaceIssueComment[];
    hasMore: boolean;
    nextCursor?: string | null;
    limit: number;
  };
  attachments: SpaceAttachment[];
}

export interface SpaceSkill {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceSkillFile {
  id: string;
  path: string;
  name: string;
  parentPath: string;
  isDir: boolean;
  sizeBytes?: number | null;
  mimeType?: string | null;
  createdAt: string;
}

export interface SpaceSkillDetail {
  skill: SpaceSkill;
  revision?: Record<string, unknown> | null;
  files: SpaceSkillFile[];
}

export interface LocalRegisteredAgent {
  id: string;
  baseUrl: string;
  spaceId: string;
  workspaceId?: string | null;
  displayName: string;
  workspacePath: string;
  workspaceLabel?: string | null;
  goalMd: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface SpaceDispatchItem {
  dispatch: {
    id: string;
    spaceId: string;
    issueId: string;
    registeredAgentId: string;
    deliveryStatus: string;
    goalSnapshotMd: string;
    createdAt: string;
    updatedAt: string;
  };
  registeredAgent: {
    id: string;
    displayName: string;
    goalMd: string;
  };
  issueMeta: {
    id: string;
    title: string;
    status: string;
    updatedAt: string;
  };
}

export interface SpaceApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  hint?: string;
}

async function spaceApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await inv<SpaceApiEnvelope<T>>('cmd_space_api_request', {
    input: {
      method,
      path,
      body: body ?? null,
    },
  });
  if (!result.success) {
    throw new Error(result.error ?? `Space API failed: ${method} ${path}`);
  }
  return result.data as T;
}

export function spaceGetSession(): Promise<SpaceSession | null> {
  return inv('cmd_space_get_session');
}

export function spaceGetCapability(): Promise<SpaceBuildCapability> {
  return inv('cmd_space_get_capability');
}

export function spaceAuthStart(): Promise<{ loginToken: string; authorizationUrl: string; expiresInSeconds: number }> {
  return inv('cmd_space_auth_start');
}

export function spaceAuthPoll(loginToken: string): Promise<Record<string, unknown>> {
  return inv('cmd_space_auth_poll', { input: { loginToken } });
}

export function spaceAuthAck(loginToken: string): Promise<void> {
  return inv('cmd_space_auth_ack', { input: { loginToken } });
}

export function spaceLogout(): Promise<void> {
  return inv('cmd_space_logout');
}

export function spaceGetOfficial(): Promise<{ space: SpaceInfo; membership: SpaceMembership; tags: SpaceTag[] }> {
  return spaceApi('GET', '/api/spaces/official');
}

export function spaceListIssues(params: { q?: string; tag?: string; status?: string; cursor?: string; limit?: number }) {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.tag) search.set('tag', params.tag);
  if (params.status) search.set('status', params.status);
  if (params.cursor) search.set('cursor', params.cursor);
  search.set('limit', String(params.limit ?? 30));
  return spaceApi<{ items: SpaceIssue[]; hasMore: boolean; nextCursor?: string | null }>(
    'GET',
    `/api/spaces/official/issues?${search.toString()}`,
  );
}

export function spaceCreateIssue(input: { title: string; body: string; tags: string[] }) {
  return spaceApi<{ issue: SpaceIssue }>('POST', '/api/spaces/official/issues', input);
}

export function spaceGetIssue(id: string, commentsCursor?: string | null) {
  const search = new URLSearchParams({ commentsLimit: '5' });
  if (commentsCursor) search.set('commentsCursor', commentsCursor);
  return spaceApi<SpaceIssueDetail>('GET', `/api/issues/${encodeURIComponent(id)}?${search.toString()}`);
}

export function spaceCommentIssue(id: string, body: string) {
  return spaceApi<{ comment: SpaceIssueComment }>('POST', `/api/issues/${encodeURIComponent(id)}/comments`, { body });
}

export function spaceSetIssueStatus(id: string, status: string) {
  return spaceApi<{ status: string; updatedAt: string }>('POST', `/api/issues/${encodeURIComponent(id)}/status`, { status });
}

export function spaceCloseOwnIssue(id: string) {
  return spaceApi<{ status: string; updatedAt: string }>('POST', `/api/issues/${encodeURIComponent(id)}/close-own`, {});
}

export function spaceDispatchIssue(id: string, registeredAgentId: string) {
  return spaceApi<{ dispatch: { id: string; issueId: string; registeredAgentId: string; deliveryStatus: string; createdAt: string } }>(
    'POST',
    `/api/issues/${encodeURIComponent(id)}/dispatch`,
    { registeredAgentId },
  );
}

export function spaceListSkills() {
  return spaceApi<{ items: SpaceSkill[] }>('GET', '/api/spaces/official/skills');
}

export function spaceGetSkill(id: string) {
  return spaceApi<SpaceSkillDetail>('GET', `/api/skills/${encodeURIComponent(id)}`);
}

export function spaceGetSkillFile(id: string, path: string) {
  const search = new URLSearchParams({ path });
  return spaceApi<{ text?: string; binary?: boolean; mimeType?: string; sizeBytes?: number }>(
    'GET',
    `/api/skills/${encodeURIComponent(id)}/file-content?${search.toString()}`,
  );
}

export function spaceInstallSkill(input: {
  skillId: string;
  skillName: string;
  target: 'global' | 'project';
  workspacePath?: string;
}) {
  return inv<{ installedName: string; installedPath: string; target: string; renamed: boolean }>('cmd_space_install_skill', {
    input,
  });
}

export function spaceUploadSkillZip(input: {
  filePath: string;
  name?: string;
  description?: string;
  skillId?: string;
}) {
  return inv<{ skill: SpaceSkill }>('cmd_space_upload_skill', { input });
}

export function spaceUploadIssueAttachments(input: { issueId: string; filePaths: string[] }) {
  return inv<{ attachments: SpaceAttachment[] }>('cmd_space_upload_issue_attachments', { input });
}

export function spaceRegisterAgent(input: {
  displayName: string;
  workspaceId: string;
  workspacePath: string;
  workspaceLabel?: string;
  goalMd: string;
}) {
  return inv<LocalRegisteredAgent>('cmd_space_register_agent', { input });
}

export function spaceListLocalAgents() {
  return inv<LocalRegisteredAgent[]>('cmd_space_list_local_agents');
}

export function spacePollDispatches(registeredAgentId: string) {
  return inv<SpaceApiEnvelope<{ items: SpaceDispatchItem[] }>>('cmd_space_poll_dispatches', {
    input: { registeredAgentId },
  });
}

export function spaceMarkDispatchDelivered(input: {
  registeredAgentId: string;
  dispatchId: string;
  localTaskId?: string;
  localRunId?: string;
}) {
  return inv<SpaceApiEnvelope<{ delivered: boolean; deliveredAt?: string }>>('cmd_space_mark_dispatch_delivered', { input });
}

export function spaceProcessDispatchesOnce() {
  return inv<{ processed: number; delivered: number; errors: string[] }>('cmd_space_process_dispatches_once');
}

export function findProjectForAgent(projects: Project[], agent: LocalRegisteredAgent): Project | null {
  if (agent.workspaceId) {
    const byId = projects.find((project) => project.id === agent.workspaceId);
    if (byId) return byId;
  }
  return projects.find((project) => workspacePathsEqual(project.path, agent.workspacePath)) ?? null;
}
