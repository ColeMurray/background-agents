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

/**
 * Slack run coordinates captured at trigger time, serialized into the run's
 * generic `trigger_run_metadata` column (slack-origin runs only). `threadTs` is
 * the reply target (falls back to `messageTs`); `messageTs` is the triggering
 * message, used to clear the `eyes` reaction on completion.
 */
export interface SlackRunMetadata {
  channel: string;
  threadTs?: string;
  messageTs: string;
}

/**
 * Parse a run row's `trigger_run_metadata` as slack coordinates — null when
 * absent (a non-slack run) or malformed. Completion is best-effort, so a parse
 * failure silently no-ops rather than throwing into the dispatch path.
 */
export function getSlackRunMetadata(
  row: Pick<AutomationRunRow, "trigger_run_metadata">
): SlackRunMetadata | null {
  if (!row.trigger_run_metadata) return null;
  try {
    return JSON.parse(row.trigger_run_metadata) as SlackRunMetadata;
  } catch {
    return null;
  }
}

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
  meta: SlackRunMetadata | null;
  sessionId: string | null;
  automationName: string;
  success: boolean;
  error?: string;
  replyInThread: boolean;
}): SlackCompletionNotification | null {
  const { meta } = params;
  if (!meta) return null;
  const threadTs = meta.threadTs ?? meta.messageTs;
  if (!threadTs) return null;

  return {
    channel: meta.channel,
    threadTs,
    reactionMessageTs: meta.messageTs,
    sessionId: params.sessionId,
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
