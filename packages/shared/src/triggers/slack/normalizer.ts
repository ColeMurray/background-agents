/**
 * Normalize raw Slack channel messages into SlackAutomationEvent objects.
 */

import type { SlackAutomationEvent } from "../types";

/** Max length of message text retained for matching + context (characters). */
export const SLACK_TEXT_MAX_LENGTH = 8 * 1024;

/** Minimal shape of the Slack `message` event fields the normalizer consumes. */
export interface SlackMessageInput {
  channel: string;
  ts: string;
  thread_ts?: string;
  user: string;
  text: string;
}

/** Bot-fetched channel metadata the shared normalizer cannot resolve itself. */
export interface SlackChannelMeta {
  channelName?: string;
  permalink?: string;
}

/** Matches both the bare `<@U…>` and piped `<@U…|display-name>` renderings. */
function botMentionPattern(botUserId: string): RegExp {
  return new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
}

function buildContextBlock(params: {
  channelLabel: string;
  actorUserId: string;
  permalink?: string;
  text: string;
}): string {
  const lines = [
    `A message was posted in Slack channel ${params.channelLabel} by user ${params.actorUserId}.`,
  ];
  if (params.permalink) lines.push(`Permalink: ${params.permalink}`);
  lines.push("", "<user_content>", params.text, "</user_content>");
  return lines.join("\n");
}

/**
 * Normalize a Slack channel message into a SlackAutomationEvent.
 * Returns null when the message has no usable text (e.g. it is only the bot mention).
 *
 * The caller (slack-bot) supplies `botUserId` so the bot's own mention token is
 * stripped, and `channelMeta` for the human-readable name + permalink the shared
 * package cannot fetch (it has no Slack token).
 */
export function normalizeSlackEvent(
  input: SlackMessageInput,
  botUserId: string,
  channelMeta?: SlackChannelMeta
): SlackAutomationEvent | null {
  const stripped = (input.text ?? "").replace(botMentionPattern(botUserId), "").trim();
  if (!stripped) return null;

  const text = stripped.slice(0, SLACK_TEXT_MAX_LENGTH);
  const channelLabel = channelMeta?.channelName ? `#${channelMeta.channelName}` : input.channel;

  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:${input.channel}:${input.ts}`,
    concurrencyKey: `slack:${input.channel}:${input.thread_ts ?? input.ts}`,
    channelId: input.channel,
    channelName: channelMeta?.channelName,
    threadTs: input.thread_ts,
    ts: input.ts,
    actorUserId: input.user,
    text,
    contextBlock: buildContextBlock({
      channelLabel,
      actorUserId: input.user,
      permalink: channelMeta?.permalink,
      text,
    }),
    meta: {
      channelId: input.channel,
      ts: input.ts,
      threadTs: input.thread_ts,
      permalink: channelMeta?.permalink,
    },
  };
}
