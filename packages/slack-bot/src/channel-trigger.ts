/**
 * Channel-message automation trigger ingress.
 *
 * Ambient (non-mention) messages in watched Slack channels are normalized and
 * forwarded to the control plane, which owns candidate selection, condition
 * evaluation, and dedup. All ingress filtering lives here so the Slack event ack
 * path stays cheap.
 */

import {
  addReaction,
  getChannelInfo,
  getPermalink,
  normalizeSlackEvent,
  type SlackAutomationEvent,
  type SlackChannelMeta,
} from "@open-inspect/shared";
import type { Env } from "./types";
import { isChannelTriggerCandidate } from "./dm-utils";
import { getWatchedChannels } from "./classifier/repos";
import { getBotUserId } from "./bot-identity";
import { getAuthHeaders } from "./internal-auth";
import { createLogger } from "./logger";

const log = createLogger("channel-trigger");

/**
 * Ingest an ambient channel message and, if it is a trigger candidate in a
 * watched channel, normalize and forward it to the control plane's
 * `/internal/slack-event` endpoint for automation matching.
 *
 * All filtering happens here so the Slack event ack path stays cheap:
 * 1. Kill switch (`SLACK_TRIGGERS_ENABLED`) — dark by default.
 * 2. Bot identity (fail closed — no id ⇒ skip, since mention suppression needs it).
 * 3. Structural candidacy + mention suppression (`isChannelTriggerCandidate`).
 * 4. Watched-channel pre-filter (cached) — avoids forwarding every channel message.
 * 5. Normalize (+ best-effort channel name/permalink) and forward.
 */
export async function handleChannelTrigger(
  event: {
    type: string;
    subtype?: string;
    channel_type?: string;
    text?: string;
    channel?: string;
    ts?: string;
    user?: string;
    thread_ts?: string;
    bot_id?: string;
  },
  env: Env,
  traceId: string | undefined
): Promise<void> {
  if (env.SLACK_TRIGGERS_ENABLED !== "true") {
    return;
  }

  const botUserId = await getBotUserId(env, traceId);
  if (!botUserId) {
    log.warn("slack_trigger.skip", { trace_id: traceId, reason: "no_bot_user_id" });
    return;
  }

  if (!isChannelTriggerCandidate(event, botUserId)) {
    return;
  }

  const channel = event.channel!;
  const watched = await getWatchedChannels(env, traceId);
  if (!watched.has(channel)) {
    return;
  }

  const channelMeta = await fetchChannelMeta(env, channel, event.ts!);
  const normalized = normalizeSlackEvent(
    {
      channel,
      ts: event.ts!,
      thread_ts: event.thread_ts,
      user: event.user!,
      text: event.text!,
    },
    botUserId,
    channelMeta
  );
  // Null when the message was only the bot mention (no usable text after strip).
  if (!normalized) {
    return;
  }

  await forwardSlackEvent(env, normalized, traceId);
}

/**
 * Best-effort fetch of the channel name + message permalink used to enrich the
 * agent's context block. Both are optional: on any Slack API failure the
 * corresponding field is left undefined and the normalizer falls back to the
 * raw channel id.
 */
async function fetchChannelMeta(env: Env, channel: string, ts: string): Promise<SlackChannelMeta> {
  const [info, link] = await Promise.all([
    getChannelInfo(env.SLACK_BOT_TOKEN, channel),
    getPermalink(env.SLACK_BOT_TOKEN, channel, ts),
  ]);
  return {
    channelName: info.ok ? info.channel.name : undefined,
    permalink: link.ok ? link.permalink : undefined,
  };
}

/**
 * Forward a normalized Slack automation event to the control plane. The
 * control plane owns candidate selection, condition evaluation, and dedup; the
 * bot's job ends at delivery.
 */
async function forwardSlackEvent(
  env: Env,
  event: SlackAutomationEvent,
  traceId: string | undefined
): Promise<void> {
  const startTime = Date.now();
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/internal/slack-event", {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      log.error("slack_trigger.forward", {
        trace_id: traceId,
        outcome: "error",
        http_status: response.status,
        channel_id: event.channelId,
        duration_ms: Date.now() - startTime,
      });
      return;
    }

    const result = (await response.json()) as {
      triggered?: number;
      skipped?: number;
      steered?: number;
    };
    log.info("slack_trigger.forward", {
      trace_id: traceId,
      outcome: "success",
      channel_id: event.channelId,
      triggered: result.triggered ?? 0,
      skipped: result.skipped ?? 0,
      steered: result.steered ?? 0,
      duration_ms: Date.now() - startTime,
    });

    // React 👀 on the triggering message when a new run materializes or a
    // follow-up steers an already-active run's session, so unmatched channel
    // chatter stays unmarked. The reaction clears when the work finishes — via
    // /callbacks/automation-complete for a new run, or /callbacks/complete for a
    // steered follow-up turn.
    if ((result.triggered ?? 0) >= 1 || (result.steered ?? 0) >= 1) {
      const reaction = await addReaction(env.SLACK_BOT_TOKEN, event.channelId, event.ts, "eyes");
      if (!reaction.ok && reaction.error !== "already_reacted") {
        log.warn("slack_trigger.react", {
          trace_id: traceId,
          channel_id: event.channelId,
          message_ts: event.ts,
          slack_error: reaction.error,
        });
      }
    }
  } catch (e) {
    log.error("slack_trigger.forward", {
      trace_id: traceId,
      outcome: "error",
      channel_id: event.channelId,
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
  }
}
