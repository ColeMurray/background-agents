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

/**
 * Compose the context block an agent receives for a Slack-triggered run.
 *
 * Exported because the block is built twice: once at ingress without thread
 * history, and again by the scheduler once a run has actually been admitted and
 * the thread has been fetched. Both go through here so there is one layout and
 * no string surgery to splice history in afterwards.
 *
 * `threadContext` is pre-rendered by slack-bot, which owns the Slack token and
 * display-name resolution.
 */
export function buildSlackContextBlock(params: {
  channelLabel: string;
  actorUserId: string;
  permalink?: string;
  text: string;
  threadContext?: string;
}): string {
  const lines = [
    `A message was posted in Slack channel ${params.channelLabel} by user ${params.actorUserId}.`,
  ];
  if (params.permalink) lines.push(`Permalink: ${params.permalink}`);
  if (params.threadContext) lines.push("", params.threadContext);
  lines.push("", "<user_content>", params.text, "</user_content>");
  return lines.join("\n");
}

/** The `#name` form when known, else the raw channel id. */
export function slackChannelLabel(channelId: string, channelName?: string): string {
  return channelName ? `#${channelName}` : channelId;
}

/**
 * Normalize a Slack channel message into a SlackAutomationEvent.
 * Returns null when the message has no usable text (e.g. it is only the bot mention).
 *
 * The caller (slack-bot) supplies `botUserId` so the bot's own mention token is
 * stripped, and `channelMeta` for the human-readable name + permalink the shared
 * package cannot fetch (it has no Slack token). Thread history is not read here:
 * it is fetched lazily, only once a run is admitted (see the scheduler).
 */
export function normalizeSlackEvent(
  input: SlackMessageInput,
  botUserId: string,
  channelMeta?: SlackChannelMeta
): SlackAutomationEvent | null {
  const stripped = (input.text ?? "").replace(botMentionPattern(botUserId), "").trim();
  if (!stripped) return null;

  const text = stripped.slice(0, SLACK_TEXT_MAX_LENGTH);
  const channelLabel = slackChannelLabel(input.channel, channelMeta?.channelName);

  return {
    source: "slack",
    eventType: "message.posted",
    triggerKey: `slack:msg:${input.channel}:${input.ts}`,
    concurrencyKey: `slack:${input.channel}:${input.thread_ts ?? input.ts}`,
    channelId: input.channel,
    channelName: channelMeta?.channelName,
    permalink: channelMeta?.permalink,
    threadTs: input.thread_ts,
    ts: input.ts,
    actorUserId: input.user,
    text,
    contextBlock: buildSlackContextBlock({
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
