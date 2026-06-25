/**
 * Pure builders for the scheduler → slack-bot notifications (run completion and
 * concurrency-skip). Kept free of Durable Object state so they can be unit
 * tested directly; the SchedulerDO method signs the result (HMAC over the JSON
 * body) and POSTs it via the optional `SLACK_BOT` Fetcher.
 *
 * Returning `null` from either builder is the explicit signal to skip the bot
 * call — for a non-slack run, a slack run with no triggering message, or a skip
 * with no actor to address.
 */

import type { AutomationRunRow } from "../db/automation-store";

/**
 * Slack run coordinates captured at trigger time, serialized into the run's
 * generic `trigger_run_metadata` column (slack-origin runs only). `messageTs` is
 * the triggering message, used to clear the `eyes` reaction on completion.
 */
export interface SlackRunMetadata {
  channel: string;
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

/**
 * Run result fields the bot needs to post the agent's final response into the
 * triggering message's thread. The SchedulerDO sources `sessionId`/`messageId`
 * (and success/error) from the run-complete callback and repo/model from the
 * automation row.
 */
export interface SlackCompletionContext {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * The scheduler → bot payload for a completed slack-triggered run. Carries the
 * triggering message (the thread anchor and the `eyes` reaction target) plus the
 * run result the bot uses to fetch and post the agent's response in-thread.
 */
export interface SlackCompletionNotification extends SlackCompletionContext {
  channel: string;
  /** The triggering message: the thread anchor and the `eyes` reaction target. */
  reactionMessageTs: string;
}

export function buildSlackCompletionNotification(
  meta: SlackRunMetadata | null,
  ctx: SlackCompletionContext
): SlackCompletionNotification | null {
  if (!meta?.messageTs) return null;
  return { channel: meta.channel, reactionMessageTs: meta.messageTs, ...ctx };
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
