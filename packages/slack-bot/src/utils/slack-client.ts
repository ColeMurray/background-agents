/**
 * Slack client utilities.
 */

import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared";

/**
 * Verify Slack request signature using Web Crypto API.
 *
 * @param signature - X-Slack-Signature header
 * @param timestamp - X-Slack-Request-Timestamp header
 * @param body - Raw request body
 * @param signingSecret - Slack app signing secret
 * @returns true if signature is valid
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

  // Prevent replay attacks (5 minute window)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false;
  }

  // Build the signature base string
  const baseString = `v0:${timestamp}:${body}`;

  // Compute HMAC-SHA256 and format as Slack expects: v0=<hex>
  const hashHex = await computeHmacHex(baseString, signingSecret);
  const expectedSignature = `v0=${hashHex}`;

  return timingSafeEqual(signature, expectedSignature);
}

/**
 * Post a message to Slack.
 */
export async function postMessage(
  token: string,
  channel: string,
  text: string,
  options?: {
    thread_ts?: string;
    blocks?: unknown[];
    reply_broadcast?: boolean;
  }
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      thread_ts: options?.thread_ts,
      blocks: options?.blocks,
      reply_broadcast: options?.reply_broadcast,
    }),
  });

  return response.json() as Promise<{ ok: boolean; ts?: string; error?: string }>;
}

/**
 * Update a Slack message.
 */
export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  options?: {
    blocks?: unknown[];
  }
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      ts,
      text,
      blocks: options?.blocks,
    }),
  });

  return response.json() as Promise<{ ok: boolean; error?: string }>;
}

/**
 * Add a reaction to a Slack message.
 */
export async function addReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("https://slack.com/api/reactions.add", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      timestamp: messageTs,
      name,
    }),
  });

  return response.json() as Promise<{ ok: boolean; error?: string }>;
}

/**
 * Remove a reaction from a Slack message.
 */
export async function removeReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("https://slack.com/api/reactions.remove", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      timestamp: messageTs,
      name,
    }),
  });

  return response.json() as Promise<{ ok: boolean; error?: string }>;
}

/**
 * Get channel info.
 */
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
}> {
  const response = await fetch(`https://slack.com/api/conversations.info?channel=${channelId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.json() as Promise<{
    ok: boolean;
    channel?: {
      id: string;
      name: string;
      topic?: { value: string };
      purpose?: { value: string };
    };
    error?: string;
  }>;
}

/**
 * Get thread messages.
 */
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
}> {
  const response = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channelId}&ts=${threadTs}&limit=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return response.json() as Promise<{
    ok: boolean;
    messages?: Array<{
      ts: string;
      text: string;
      user?: string;
      bot_id?: string;
    }>;
    error?: string;
  }>;
}

/**
 * Get user profile info.
 */
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
    };
  };
  error?: string;
}> {
  const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  return response.json() as Promise<{
    ok: boolean;
    user?: {
      id: string;
      name: string;
      real_name?: string;
      profile?: {
        display_name?: string;
        real_name?: string;
      };
    };
    error?: string;
  }>;
}

/**
 * Publish a view to a user's App Home tab.
 */
export async function publishView(
  token: string,
  userId: string,
  view: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("https://slack.com/api/views.publish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, view }),
  });

  return response.json() as Promise<{ ok: boolean; error?: string }>;
}

/**
 * Open a modal view in Slack.
 */
export async function openView(
  token: string,
  triggerId: string,
  view: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  const response = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });

  return response.json() as Promise<{ ok: boolean; error?: string }>;
}
