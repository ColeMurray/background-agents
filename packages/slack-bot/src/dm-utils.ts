/**
 * Strip Slack user mention tokens (e.g. <@U12345>) from text.
 * DMs may include self-mentions when users type "@Bot <request>".
 */
export function stripMentions(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Returns true if a Slack message event should be dispatched as a DM.
 * Filters out subtypes (bot_message, message_changed, message_deleted, etc.)
 * to prevent processing bot replies and edit/delete notifications.
 */
export function isDmDispatchable(event: {
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
    event.channel_type === "im" &&
    !!event.text &&
    !!event.channel &&
    !!event.ts &&
    !!event.user
  );
}
