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
 * Returns true if a Slack message event is a dispatchable private message — a 1:1 DM
 * (`im`) or a group DM (`mpim`). Filters out subtypes (bot_message, message_changed,
 * message_deleted, etc.) to prevent processing bot replies and edit/delete notifications.
 */
export function isPrivateMessageDispatchable(event: {
  type: string;
  subtype?: string;
  channel_type?: string;
  text?: string;
  channel?: string;
  ts?: string;
  user?: string;
}): boolean {
  return (
    event.type === "message" &&
    !event.subtype &&
    (event.channel_type === "im" || event.channel_type === "mpim") &&
    !!event.text &&
    !!event.channel &&
    !!event.ts &&
    !!event.user
  );
}
