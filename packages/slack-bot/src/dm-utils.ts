import { applyMentionPolicy } from "@open-inspect/shared/slack";
import type { SlackMessageAuthor } from "@open-inspect/shared/triggers";
import type { BotIdentity } from "./bot-identity";

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
 * so they dispatch on their files instead; a forwarded message with no comment
 * likewise carries its content in `attachments` and no text at all.
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
  attachments?: unknown[];
}): boolean {
  const subtypeOk = !event.subtype || event.subtype === "file_share";
  const hasContent =
    !!event.text || (event.files?.length ?? 0) > 0 || (event.attachments?.length ?? 0) > 0;
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
 * Returns the author of a Slack channel message when it should be considered an
 * automation trigger candidate (an ambient message that may match a watched
 * automation), or null when it should be dropped.
 *
 * This is the structural pre-filter the bot applies before normalizing and
 * forwarding to the control plane. It drops:
 * - non-`message` events and any subtype other than `file_share` and
 *   `bot_message` (edits, joins, …). A message that carries an attachment
 *   arrives as `file_share` but is otherwise an ordinary message, and dropping
 *   it made the request that opens a thread invisible whenever it came with a
 *   file. Only its text triggers — the attachment is not forwarded to the
 *   session (matching automation thread replies).
 * - DM (`im`) and group-DM (`mpim`) channels — handled by the DM path
 * - messages from the bot itself, by its user id or its bot id
 * - every bot message while the bot's own bot id is unknown (fail closed: such
 *   a message could be the bot's own)
 * - messages that @mention the bot — those are explicit requests dispatched by
 *   the `app_mention` path; processing them here too would double-handle.
 *
 * Messages from other bots and integrations pass identified by their `bot_id`
 * alone, even an app bot that also carries a `user`: whether one may trigger is
 * a per-automation setting the control plane applies, and a control plane that
 * predates bot messages rejects an author without a user rather than taking the
 * bot for a person.
 *
 * `identity` must be the bot's own ids (from `auth.test`); the caller resolves
 * it and fails closed when it cannot, so mention suppression and
 * self-exclusion are always applied against a known user id.
 */
export function channelTriggerAuthor(
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
  identity: BotIdentity
): SlackMessageAuthor | null {
  if (event.type !== "message") return null;
  if (event.subtype === "bot_message" && !event.bot_id) return null;
  if (event.subtype && event.subtype !== "file_share" && event.subtype !== "bot_message") {
    return null;
  }
  if (event.channel_type !== "channel" && event.channel_type !== "group") return null;
  if (!event.text || !event.channel || !event.ts) return null;
  if (event.user === identity.userId) return null;
  if (mentionsUser(event.text, identity.userId)) return null;
  if (!event.bot_id) return event.user ? { user: event.user } : null;
  if (!identity.botId || event.bot_id === identity.botId) return null;
  return { bot_id: event.bot_id };
}
