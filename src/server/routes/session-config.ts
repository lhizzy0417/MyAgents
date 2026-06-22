import type { McpServerDefinition } from '../../shared/config-types';
import { getSessionEngine } from '../session-engine';
import type { PermissionMode, ProviderEnv } from '../session-engine/types';
import type { InteractionScenario } from '../system-prompt';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function parseDesktopInteractionScenario(value: unknown): Extract<InteractionScenario, { type: 'desktop' }> | null {
  if (!value || typeof value !== 'object') return null;
  const scenario = value as { type?: unknown; surface?: unknown };
  if (scenario.type !== 'desktop') return null;
  if (scenario.surface === undefined) return { type: 'desktop' };
  if (scenario.surface === 'chat' || scenario.surface === 'floating-ball') {
    return { type: 'desktop', surface: scenario.surface };
  }
  return null;
}

export async function handleSessionConfigRoute(
  pathname: string,
  request: Request,
): Promise<Response | null> {
  if (pathname === '/api/interaction-scenario/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { scenario?: unknown };
      const scenario = parseDesktopInteractionScenario(payload?.scenario);
      if (!scenario) {
        return jsonResponse({ success: false, error: 'Invalid desktop interaction scenario.' }, 400);
      }
      const result = await getSessionEngine().updateDesktopInteractionScenario(scenario);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/interaction-scenario/set] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Failed to set interaction scenario' },
        500,
      );
    }
  }

  if (pathname === '/api/mcp/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { servers?: McpServerDefinition[] };
      const servers = payload?.servers ?? [];
      const result = await getSessionEngine().updateMcpServers(servers);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/mcp/set] Error:', error);
      return jsonResponse(
        { success: false, error: error instanceof Error ? error.message : 'Failed to set MCP servers' },
        500,
      );
    }
  }

  if (pathname === '/api/agents/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { agents: Record<string, unknown> };
      const result = await getSessionEngine().updateAgents(payload.agents);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/agents/set] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set agents' }, 500);
    }
  }

  if (pathname === '/api/provider/set' && request.method === 'POST') {
    try {
      const payload = await request.json() as { providerEnv?: Record<string, unknown> | null };
      const providerEnv = (payload?.providerEnv ?? undefined) as ProviderEnv | undefined;
      const result = await getSessionEngine().updateProviderEnv(providerEnv);
      return jsonResponse(result.success ? { success: true } : result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/provider/set] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set provider' }, 500);
    }
  }

  if (pathname === '/api/session/permission-mode' && request.method === 'POST') {
    try {
      const payload = await request.json() as { permissionMode?: string };
      if (!payload?.permissionMode) {
        return jsonResponse({ success: false, error: 'permissionMode is required' }, 400);
      }
      const result = await getSessionEngine().updatePermissionMode(payload.permissionMode as PermissionMode);
      return jsonResponse(result, result.success ? 200 : 500);
    } catch (error) {
      console.error('[api/session/permission-mode] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to set permission mode' }, 500);
    }
  }

  if (pathname === '/api/session/config' && request.method === 'GET') {
    try {
      return jsonResponse(getSessionEngine().getSessionConfigSnapshot());
    } catch (error) {
      console.error('[api/session/config] Error:', error);
      return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Failed to get session config' }, 500);
    }
  }

  return null;
}
