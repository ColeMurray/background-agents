/**
 * Slack Notify Tool — post a message to a Slack channel via the control plane.
 *
 * The bot token never enters the sandbox. This tool is only installed when
 * AGENT_SLACK_NOTIFY_ENABLED=true at spawn time.
 *
 * Output is a JSON envelope so the web transcript renderer can show a rich
 * row using the agent's own tool_call event as the single source of truth.
 *
 * Success envelope:  { ok: true,  channelInput, channelId, messageTs, permalink, truncated, strippedBroadcasts, mentionsModified }
 * Failure envelope:  { ok: false, reason, agentMessage, retryAfter? }
 *
 * `agentMessage` carries human guidance for the model; `reason` is the stable
 * code the renderer keys off. The reason keys here must stay symmetric with
 * `SLACK_DENIAL_REASONS` in `@open-inspect/shared/slack/types` — this file
 * ships into the sandbox image and cannot import from the workspace.
 */
import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { bridgeFetch } from "./_bridge-client.js";

const REASON_GUIDANCE = {
  feature_unavailable:
    "The deployment is not configured to send agent notifications. Tell the user this is unavailable.",
  feature_disabled:
    "Agent notifications are disabled for this repository. Ask the user to enable them in integration settings.",
  channel_not_found_or_forbidden:
    "The channel was not found, is archived, or the bot is not in it. If the channel name is correct and not archived, ask the user to invite the bot.",
  empty_message_after_sanitization:
    "The message body was empty after sanitization. Try again with non-empty content.",
  rate_limited: "Slack rate-limited the request. Wait before retrying.",
  slack_api_error: "Slack returned an unexpected error. The post did not go through.",
  invalid_input: "The notification arguments were invalid; correct them and retry.",
  bridge_error: "Could not reach the control plane to post the notification.",
};

const STATUS_FALLBACK_REASON = {
  400: "invalid_input",
  403: "feature_disabled",
  404: "channel_not_found_or_forbidden",
  422: "empty_message_after_sanitization",
  429: "rate_limited",
  503: "feature_unavailable",
};

function isKnownReason(reason) {
  return (
    typeof reason === "string" && Object.prototype.hasOwnProperty.call(REASON_GUIDANCE, reason)
  );
}

function buildFailureEnvelope(reason, message, retryAfter) {
  const guidance = REASON_GUIDANCE[reason] ?? REASON_GUIDANCE.slack_api_error;
  const detail = message ? `${guidance} (${message})` : guidance;
  const envelope = { ok: false, reason, agentMessage: detail };
  if (typeof retryAfter === "number") {
    envelope.retryAfter = retryAfter;
  }
  return JSON.stringify(envelope);
}

async function readErrorBody(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return { reason: undefined, message: undefined, retryAfter: undefined };
  }
  try {
    const body = JSON.parse(text);
    return {
      reason: typeof body.error === "string" ? body.error : undefined,
      message: typeof body.message === "string" ? body.message : undefined,
      retryAfter: typeof body.retryAfter === "number" ? body.retryAfter : undefined,
    };
  } catch {
    return { reason: undefined, message: text || undefined, retryAfter: undefined };
  }
}

export default tool({
  name: "slack-notify",
  description:
    "Post a message to a Slack channel that the user has authorized. Use this only when the user has explicitly asked you to notify Slack — this is an externally-visible action that other humans will see. The user must tell you which channel; do not guess. The bot must already be invited to the channel; if you get channel_not_found_or_forbidden, ask the user to invite the bot. Plain text + Slack mrkdwn formatting only (bold *...*, italic _..._, inline code `...`, fenced blocks, lists, blockquotes). The server attaches the attribution footer and View Session button — do not fabricate them.",
  args: {
    channel: z
      .string()
      .describe(
        "Target channel as either a channel ID (e.g. C01ABC) or the channel name as the user said it (e.g. ops or #ops). Passed verbatim to Slack — no resolution or lookup."
      ),
    text: z
      .string()
      .describe(
        "Message body. Plain text + Slack mrkdwn (bold *...*, italic _..._, inline code `...`, fenced blocks, lists, blockquotes). No interactive elements. Direct user mentions <@U...> are subject to the workspace's mentions policy; broadcast mentions <!channel>/<!here>/<!subteam^...> are always stripped server-side."
      ),
    thread_ts: z
      .string()
      .optional()
      .describe(
        "Optional Slack thread timestamp to reply within an existing thread. Same channel-membership rules apply."
      ),
    reason: z
      .string()
      .optional()
      .describe(
        "Optional short note explaining why you are posting. Recorded server-side for audit; not shown in Slack."
      ),
  },
  async execute(args) {
    let response;
    try {
      response = await bridgeFetch("/slack-notify", {
        method: "POST",
        body: JSON.stringify({
          channel: args.channel,
          text: args.text,
          thread_ts: args.thread_ts,
          reason: args.reason,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildFailureEnvelope("bridge_error", message);
    }

    if (response.ok) {
      try {
        const result = await response.json();
        return JSON.stringify(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return buildFailureEnvelope(
          "slack_api_error",
          `Control plane returned a non-JSON 2xx response: ${message}`
        );
      }
    }

    const { reason, message, retryAfter } = await readErrorBody(response);
    const fallbackReason = STATUS_FALLBACK_REASON[response.status] ?? "slack_api_error";
    const finalReason = isKnownReason(reason) ? reason : fallbackReason;
    return buildFailureEnvelope(finalReason, message, retryAfter);
  },
});
