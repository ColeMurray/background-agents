/**
 * Slack Web API client. The bot token is the first positional argument on
 * every method so that distinct workers (slack-bot, control-plane) can
 * supply their own token without sharing module-level state.
 *
 * Errors from the Slack API are returned as `{ ok: false, error }` envelopes;
 * HTTP-level failures (4xx/5xx, network errors, malformed bodies) are
 * mapped into the same envelope shape so callers never need to catch.
 */

import { computeHmacHex, timingSafeEqual } from "../auth";

const SLACK_API_BASE = "https://slack.com/api";

interface SlackResponseBase {
  ok: boolean;
  error?: string;
  retryAfter?: number;
}

interface SlackFetchInit {
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

async function slackFetch<T extends SlackResponseBase>(
  token: string,
  endpoint: string,
  init?: SlackFetchInit
): Promise<T> {
  const url = init?.query
    ? `${SLACK_API_BASE}/${endpoint}?${new URLSearchParams(init.query).toString()}`
    : `${SLACK_API_BASE}/${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (init?.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const response = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body,
  });

  if (response.status === 429) {
    const retryHeader = response.headers.get("retry-after");
    const parsed = retryHeader ? parseInt(retryHeader, 10) : NaN;
    return {
      ok: false,
      error: "ratelimited",
      ...(Number.isFinite(parsed) ? { retryAfter: parsed } : {}),
    } as T;
  }

  if (!response.ok) {
    return { ok: false, error: `http_${response.status}` } as T;
  }

  try {
    return (await response.json()) as T;
  } catch {
    return { ok: false, error: "invalid_response" } as T;
  }
}

/**
 * Verify a Slack request signature using the Web Crypto API.
 *
 * Enforces a 5-minute replay-attack window on the timestamp.
 */
export async function verifySlackSignature(
  signature: string | null,
  timestamp: string | null,
  body: string,
  signingSecret: string
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false;
  }

  const baseString = `v0:${timestamp}:${body}`;
  const hashHex = await computeHmacHex(baseString, signingSecret);
  const expectedSignature = `v0=${hashHex}`;

  return timingSafeEqual(signature, expectedSignature);
}

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  options?: {
    thread_ts?: string;
    blocks?: unknown[];
    reply_broadcast?: boolean;
  }
): Promise<{
  ok: boolean;
  ts?: string;
  error?: string;
  retryAfter?: number;
}> {
  return slackFetch(token, "chat.postMessage", {
    method: "POST",
    body: {
      channel,
      text,
      thread_ts: options?.thread_ts,
      blocks: options?.blocks,
      reply_broadcast: options?.reply_broadcast,
    },
  });
}

export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  options?: {
    blocks?: unknown[];
  }
): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  return slackFetch(token, "chat.update", {
    method: "POST",
    body: {
      channel,
      ts,
      text,
      blocks: options?.blocks,
    },
  });
}

export async function addReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  return slackFetch(token, "reactions.add", {
    method: "POST",
    body: { channel, timestamp: messageTs, name },
  });
}

export async function removeReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  return slackFetch(token, "reactions.remove", {
    method: "POST",
    body: { channel, timestamp: messageTs, name },
  });
}

export async function getChannelInfo(
  token: string,
  channelId: string
): Promise<{
  ok: boolean;
  channel?: {
    id: string;
    name: string;
    topic?: { value: string };
    purpose?: { value: string };
  };
  error?: string;
  retryAfter?: number;
}> {
  return slackFetch(token, "conversations.info", {
    query: { channel: channelId },
  });
}

export async function getThreadMessages(
  token: string,
  channelId: string,
  threadTs: string,
  limit = 10
): Promise<{
  ok: boolean;
  messages?: Array<{
    ts: string;
    text: string;
    user?: string;
    bot_id?: string;
  }>;
  error?: string;
  retryAfter?: number;
}> {
  return slackFetch(token, "conversations.replies", {
    query: { channel: channelId, ts: threadTs, limit: String(limit) },
  });
}

export async function getUserInfo(
  token: string,
  userId: string
): Promise<{
  ok: boolean;
  user?: {
    id: string;
    name: string;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  };
  error?: string;
  retryAfter?: number;
}> {
  return slackFetch(token, "users.info", {
    query: { user: userId },
  });
}

export async function publishView(
  token: string,
  userId: string,
  view: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  return slackFetch(token, "views.publish", {
    method: "POST",
    body: { user_id: userId, view },
  });
}

export async function openView(
  token: string,
  triggerId: string,
  view: Record<string, unknown>
): Promise<{ ok: boolean; error?: string; retryAfter?: number }> {
  return slackFetch(token, "views.open", {
    method: "POST",
    body: { trigger_id: triggerId, view },
  });
}
