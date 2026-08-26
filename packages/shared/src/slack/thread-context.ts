/**
 * Pure helpers for turning a fetched Slack thread into agent context.
 *
 * Two call sites need the same policy: the interactive `@mention` path
 * (message-handler) and the channel-trigger automation path. They previously
 * implemented window selection and speaker classification separately and drifted
 * — different limits, different bot handling, different timestamp filtering.
 * The selection and classification rules live here; each caller still formats
 * its own prompt, and Slack API access plus display-name resolution stay in
 * slack-bot, which owns the token.
 */

import type { SlackThreadMessage } from "./client";

/** Slack `ts` values are `<seconds>.<microseconds>` strings; compare numerically. */
function tsValue(ts: string): number {
  return Number.parseFloat(ts);
}

export interface ThreadWindowOptions {
  /** Drop this message — normally the one that triggered the run. */
  excludeTs?: string;
  /**
   * Keep only messages strictly older than this ts. `conversations.replies` can
   * return replies posted between the trigger and the fetch, and presenting a
   * later message as prior context is both wrong and a way to leak newer thread
   * state into a run.
   */
  beforeTs?: string;
  /** Keep only messages strictly newer than this ts (interactive "since last turn"). */
  sinceTs?: string;
  /** Keep at most this many messages, taken from the end (most recent). */
  limit: number;
  /** Drop messages posted by any bot or app. */
  excludeBots?: boolean;
  /**
   * Always keep the thread's root message when it survives the other filters,
   * even if the tail limit would otherwise drop it. On a long thread the root
   * is usually the actual request, so losing it leaves an agent reading replies
   * to a question it cannot see.
   */
  keepRootTs?: string;
}

/**
 * Select the messages to show, oldest-first, applying the exclusions before the
 * tail limit so a dropped message never consumes a slot.
 */
export function selectThreadWindow(
  messages: SlackThreadMessage[],
  options: ThreadWindowOptions
): SlackThreadMessage[] {
  const { excludeTs, beforeTs, sinceTs, limit, excludeBots, keepRootTs } = options;

  const eligible = messages.filter((message) => {
    if (excludeTs && message.ts === excludeTs) return false;
    if (excludeBots && message.bot_id) return false;
    if (beforeTs && tsValue(message.ts) >= tsValue(beforeTs)) return false;
    if (sinceTs && tsValue(message.ts) <= tsValue(sinceTs)) return false;
    return true;
  });

  if (limit <= 0) return [];
  if (eligible.length <= limit) return eligible;

  const tail = eligible.slice(-limit);
  const root = keepRootTs ? eligible.find((message) => message.ts === keepRootTs) : undefined;
  if (!root || tail.some((message) => message.ts === root.ts)) return tail;

  // Surrender the oldest tail slot to the root rather than growing the window.
  return [root, ...tail.slice(1)];
}

export type ThreadSpeaker =
  /** The bot whose context this is — its own earlier turns. */
  | { kind: "self" }
  /** Another app or bot integration. */
  | { kind: "app"; id: string }
  /** A person. */
  | { kind: "user"; id: string }
  | { kind: "unknown" };

/**
 * Classify who posted a message.
 *
 * `bot_id` is checked before `user` because Slack sets both on app messages
 * posted with a user identity; checking `user` first renders an app as a person,
 * which is exactly the confusion the label exists to prevent.
 */
export function classifyThreadSpeaker(
  message: SlackThreadMessage,
  botUserId?: string
): ThreadSpeaker {
  if (botUserId && message.user === botUserId) return { kind: "self" };
  if (message.bot_id) return { kind: "app", id: message.bot_id };
  if (message.user) return { kind: "user", id: message.user };
  return { kind: "unknown" };
}
