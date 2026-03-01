/**
 * Bot Framework REST API client for Teams.
 *
 * Sends activities (messages, Adaptive Cards) back through Bot Framework.
 * Uses Azure AD v2.0 client credentials flow for authentication.
 */

import { createLogger } from "../logger";

const log = createLogger("teams-client");

let tokenCache: { token: string; expiresAt: number } | null = null;

/**
 * Get an OAuth token for the Bot Framework API.
 * Caches the token and refreshes 5 minutes before expiry.
 */
export async function getBotToken(
  appId: string,
  appPassword: string,
  tenantId: string
): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 300_000) {
    return tokenCache.token;
  }

  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: "https://api.botframework.com/.default",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    log.error("bot_token.fetch", { status: response.status, body: text.slice(0, 500) });
    throw new Error(`Failed to get bot token: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/**
 * Send a threaded reply to an activity.
 */
export async function sendReply(
  serviceUrl: string,
  conversationId: string,
  replyToId: string,
  appId: string,
  appPassword: string,
  tenantId: string,
  text?: string,
  attachments?: Array<{ contentType: string; content: unknown }>
): Promise<{ id: string }> {
  const token = await getBotToken(appId, appPassword, tenantId);
  const url = `${normalizeServiceUrl(serviceUrl)}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`;

  const activity: Record<string, unknown> = {
    type: "message",
    from: { id: appId },
    conversation: { id: conversationId },
    replyToId,
  };

  if (text) activity.text = text;
  if (attachments) activity.attachments = attachments;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(activity),
  });

  if (!response.ok) {
    const body = await response.text();
    log.error("teams.send_reply", {
      status: response.status,
      conversation_id: conversationId,
      body: body.slice(0, 500),
    });
    throw new Error(`Failed to send reply: ${response.status}`);
  }

  return (await response.json()) as { id: string };
}

/**
 * Send a new activity to a conversation.
 */
export async function sendActivity(
  serviceUrl: string,
  conversationId: string,
  appId: string,
  appPassword: string,
  tenantId: string,
  text?: string,
  attachments?: Array<{ contentType: string; content: unknown }>
): Promise<{ id: string }> {
  const token = await getBotToken(appId, appPassword, tenantId);
  const url = `${normalizeServiceUrl(serviceUrl)}v3/conversations/${encodeURIComponent(conversationId)}/activities`;

  const activity: Record<string, unknown> = {
    type: "message",
    from: { id: appId },
    conversation: { id: conversationId },
  };

  if (text) activity.text = text;
  if (attachments) activity.attachments = attachments;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(activity),
  });

  if (!response.ok) {
    const body = await response.text();
    log.error("teams.send_activity", {
      status: response.status,
      conversation_id: conversationId,
      body: body.slice(0, 500),
    });
    throw new Error(`Failed to send activity: ${response.status}`);
  }

  return (await response.json()) as { id: string };
}

/**
 * Update an existing activity (e.g., update an Adaptive Card).
 */
export async function updateActivity(
  serviceUrl: string,
  conversationId: string,
  activityId: string,
  appId: string,
  appPassword: string,
  tenantId: string,
  text?: string,
  attachments?: Array<{ contentType: string; content: unknown }>
): Promise<void> {
  const token = await getBotToken(appId, appPassword, tenantId);
  const url = `${normalizeServiceUrl(serviceUrl)}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

  const activity: Record<string, unknown> = {
    type: "message",
    id: activityId,
    from: { id: appId },
    conversation: { id: conversationId },
  };

  if (text) activity.text = text;
  if (attachments) activity.attachments = attachments;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(activity),
  });

  if (!response.ok) {
    const body = await response.text();
    log.error("teams.update_activity", {
      status: response.status,
      activity_id: activityId,
      body: body.slice(0, 500),
    });
  }
}

/**
 * Send a typing indicator to a conversation.
 * Shows "Bot is typing..." in the Teams chat UI.
 */
export async function sendTypingIndicator(
  serviceUrl: string,
  conversationId: string,
  replyToId: string,
  appId: string,
  appPassword: string,
  tenantId: string
): Promise<void> {
  const token = await getBotToken(appId, appPassword, tenantId);
  const url = `${normalizeServiceUrl(serviceUrl)}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "typing",
      from: { id: appId },
      conversation: { id: conversationId },
      replyToId,
    }),
  });

  if (!response.ok) {
    log.warn("teams.typing_indicator", {
      status: response.status,
      conversation_id: conversationId,
    });
  }
}

/** Ensure serviceUrl ends with a slash. */
function normalizeServiceUrl(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

/** Clear the token cache (for testing). */
export function clearTokenCache(): void {
  tokenCache = null;
}
