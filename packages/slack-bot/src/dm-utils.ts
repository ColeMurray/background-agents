import { applyMentionPolicy } from "@open-inspect/shared";

/**
 * Strip Slack user mention tokens (e.g. <@U12345>) from text and collapse
 * resulting whitespace. DMs may include self-mentions when users type
 * "@Bot <request>".
 */
export function stripMentions(text: string): string {
  return applyMentionPolicy(text, "strip").replace(/\s+/g, " ").trim();
}

/**
 * Returns true if a Slack message event should be dispatched as a DM.
 * Filters out subtypes (bot_message, message_changed, message_deleted, etc.)
 * to prevent processing bot replies and edit/delete notifications. Messages
 * with file uploads arrive as the `file_share` subtype and may carry no text,
 * so they dispatch on their attachments instead.
 */
export function isDmDispatchable(event: {
  type: string;
  subtype?: string;
  channel_type?: string;
  text?: string;
  channel?: string;
  ts?: string;
  user?: string;
  files?: unknown[];
}): boolean {
  const subtypeOk = !event.subtype || event.subtype === "file_share";
  const hasContent = !!event.text || (event.files?.length ?? 0) > 0;
  return (
    event.type === "message" &&
    subtypeOk &&
    event.channel_type === "im" &&
    hasContent &&
    !!event.channel &&
    !!event.ts &&
    !!event.user
  );
}

/**
 * Returns true when `text` contains a mention of `userId`, matching both the
 * bare `<@U…>` and piped `<@U…|display-name>` renderings. Slack user IDs are
 * `[A-Z0-9]+`, so the id is safe to splice into the pattern verbatim.
 */
function mentionsUser(text: string, userId: string): boolean {
  return new RegExp(`<@${userId}(?:\\|[^>]*)?>`).test(text);
}

/**
 * Returns true if a Slack channel message should be considered an automation
 * trigger candidate (an ambient message that may match a watched automation).
 *
 * This is the structural pre-filter the bot applies before normalizing and
 * forwarding to the control plane. It drops:
 * - non-`message` events and any subtype (edits, joins, bot posts, …)
 * - DM (`im`) and group-DM (`mpim`) channels — handled by the DM path
 * - messages from the bot itself
 * - messages that @mention the bot — those are explicit requests dispatched by
 *   the `app_mention` path; processing them here too would double-handle.
 *
 * `botUserId` must be the bot's own Slack user id (from `auth.test`); the caller
 * resolves it and fails closed when it cannot, so mention suppression is always
 * applied against a known id.
 */
export function isChannelTriggerCandidate(
  event: {
    type: string;
    subtype?: string;
    channel_type?: string;
    text?: string;
    channel?: string;
    ts?: string;
    user?: string;
    bot_id?: string;
  },
  botUserId: string
): boolean {
  if (event.type !== "message") return false;
  if (event.subtype) return false;
  if (event.bot_id) return false;
  if (event.channel_type !== "channel" && event.channel_type !== "group") return false;
  if (!event.text || !event.channel || !event.ts || !event.user) return false;
  if (event.user === botUserId) return false;
  if (mentionsUser(event.text, botUserId)) return false;
  return true;
}
