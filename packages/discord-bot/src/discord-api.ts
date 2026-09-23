/**
 * Minimal Discord REST client.
 *
 * Interaction webhooks (`/webhooks/{app}/{token}`) need no bot token but expire
 * 15 minutes after the command; anything later — thread creation and the
 * completion reply — uses the bot token.
 */

import { z } from "zod";

const DISCORD_API = "https://discord.com/api/v10";

/** Discord rejects message content longer than this. */
export const MAX_MESSAGE_LENGTH = 2000;

class DiscordApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`Discord API ${path} failed with ${status}`);
    this.name = "DiscordApiError";
  }
}

export interface MessagePayload {
  content: string;
  /** Users the message may ping; nobody else is mentioned. */
  mentionUserIds?: string[];
  flags?: number;
}

function messageBody(payload: MessagePayload): string {
  return JSON.stringify({
    content: payload.content.slice(0, MAX_MESSAGE_LENGTH),
    allowed_mentions: { parse: [], users: payload.mentionUserIds ?? [] },
    ...(payload.flags !== undefined ? { flags: payload.flags } : {}),
  });
}

async function discordFetch(
  path: string,
  init: { method: string; body?: string; botToken?: string }
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.botToken) headers.Authorization = `Bot ${init.botToken}`;
  const response = await fetch(`${DISCORD_API}${path}`, {
    method: init.method,
    headers,
    body: init.body,
  });
  if (!response.ok) {
    throw new DiscordApiError(path, response.status, await response.text().catch(() => ""));
  }
  return response.status === 204 ? null : response.json();
}

const idSchema = z.object({ id: z.string() });

/** Replace the deferred "thinking…" reply; returns the message id. */
export async function editOriginalResponse(
  applicationId: string,
  interactionToken: string,
  payload: MessagePayload
): Promise<string> {
  const result = await discordFetch(
    `/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    { method: "PATCH", body: messageBody(payload) }
  );
  return idSchema.parse(result).id;
}

/** Open a public thread on a message; returns the thread's channel id. */
export async function startThreadFromMessage(
  botToken: string,
  channelId: string,
  messageId: string,
  name: string
): Promise<string> {
  const result = await discordFetch(`/channels/${channelId}/messages/${messageId}/threads`, {
    method: "POST",
    botToken,
    // One day of inactivity before Discord archives the thread.
    body: JSON.stringify({ name: name.slice(0, 100), auto_archive_duration: 1440 }),
  });
  return idSchema.parse(result).id;
}

export async function postChannelMessage(
  botToken: string,
  channelId: string,
  payload: MessagePayload
): Promise<void> {
  await discordFetch(`/channels/${channelId}/messages`, {
    method: "POST",
    botToken,
    body: messageBody(payload),
  });
}
