/**
 * Pure builders for the scheduler → slack-bot notifications (run completion and
 * concurrency-skip). Kept free of Durable Object state so they can be unit
 * tested directly; the SchedulerDO method signs the result (HMAC over the JSON
 * body) and POSTs it via the optional `SLACK_BOT` Fetcher.
 *
 * Returning `null` from either builder is the explicit signal to skip the bot
 * call — for a non-slack run, a slack run with no thread anchor, or a skip with
 * no actor to address.
 */

import type { AutomationRunRow } from "../db/automation-store";

/** Run-row coordinate subset the slack completion notification needs. */
export type SlackRunCoords = Pick<
  AutomationRunRow,
  "slack_channel" | "slack_thread_ts" | "slack_message_ts" | "session_id"
>;

/** Max characters of an error surfaced inline; the full transcript is one click away. */
const SUMMARY_MAX_LENGTH = 1500;

export interface SlackCompletionNotification {
  channel: string;
  threadTs: string;
  /** Message to clear the `eyes` reaction from (the triggering message). */
  reactionMessageTs?: string;
  sessionId: string | null;
  success: boolean;
  /** Short failure summary; omitted on success (the bot renders a generic ✅). */
  summary?: string;
  automationName: string;
  /**
   * The automation's reply-in-thread setting (stored in trigger_config). When
   * false, the bot still clears the `eyes` reaction but posts no completion
   * message into the thread.
   */
  replyInThread: boolean;
}

export function buildSlackCompletionNotification(params: {
  run: SlackRunCoords;
  automationName: string;
  success: boolean;
  error?: string;
  replyInThread: boolean;
}): SlackCompletionNotification | null {
  const { run } = params;
  if (!run.slack_channel) return null;
  const threadTs = run.slack_thread_ts ?? run.slack_message_ts ?? undefined;
  if (!threadTs) return null;

  return {
    channel: run.slack_channel,
    threadTs,
    reactionMessageTs: run.slack_message_ts ?? undefined,
    sessionId: run.session_id ?? null,
    success: params.success,
    summary: params.error ? params.error.slice(0, SUMMARY_MAX_LENGTH) : undefined,
    automationName: params.automationName,
    replyInThread: params.replyInThread,
  };
}

export interface SlackSkipNotification {
  channel: string;
  user: string;
  threadTs: string;
}

export function buildSlackSkipNotification(params: {
  channelId: string;
  actorUserId?: string;
  threadTs?: string;
  ts: string;
}): SlackSkipNotification | null {
  if (!params.actorUserId) return null;
  return {
    channel: params.channelId,
    user: params.actorUserId,
    threadTs: params.threadTs ?? params.ts,
  };
}
