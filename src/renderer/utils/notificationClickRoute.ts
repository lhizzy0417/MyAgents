export interface NotificationClickPayload {
  tabId?: string;
  sessionId?: string;
  workspacePath?: string;
}

export type NotificationClickRoute =
  | { type: "select-tab"; tabId: string }
  | { type: "open-session"; sessionId: string; workspacePath: string }
  | { type: "none" };

export function resolveNotificationClickRoute(
  payload: NotificationClickPayload | null | undefined,
  tabExists: (tabId: string) => boolean,
): NotificationClickRoute {
  const tabId = payload?.tabId?.trim();
  if (tabId && tabExists(tabId)) {
    return { type: "select-tab", tabId };
  }

  const sessionId = payload?.sessionId?.trim();
  const workspacePath = payload?.workspacePath?.trim();
  if (sessionId && workspacePath) {
    return { type: "open-session", sessionId, workspacePath };
  }

  return { type: "none" };
}
