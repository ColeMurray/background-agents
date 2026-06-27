/**
 * Intentionally emits no transcript events: the agent's own tool_call event
 * is the single source of truth. Audit detail lives in the structured logs.
 */

import {
  getPermalink,
  postMessage,
  sanitizeAgentText,
  SLACK_DENIAL_STATUS,
  type SlackGlobalSettings,
  type SlackNotifySuccessOutput,
  type SlackWireDenialReason,
} from "@open-inspect/shared";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { error, json, type RequestContext } from "./shared";

const logger = createLogger("slack-notify");

/** Maximum text length before truncation; fits within Slack's section block. */
const SLACK_TEXT_MAX_LENGTH = 2900;
/** Hard cap on the raw text we accept and persist verbatim in event args. */
const RAW_TEXT_INPUT_MAX_LENGTH = 12_000;
/** Channel name length cap (Slack max is 80). */
const CHANNEL_INPUT_MAX_LENGTH = 80;
/** Reason field cap; recorded for audit only. */
const REASON_MAX_LENGTH = 500;

interface ParsedBody {
  channel: string;
  text: string;
  threadTs: string | undefined;
  reason: string | undefined;
}

interface AuditFields {
  prompt_author_user_id: string | null;
  trigger_source: string | null;
  parent_session_id: string | null;
  repo: string;
}

export async function handleSlackNotify(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  const session = await new SessionIndexStore(env.DB).get(sessionId);
  if (!session) {
    return failureResponse("invalid_input", "Session not found.");
  }

  const repoScope =
    session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null;
  const audit: AuditFields = {
    prompt_author_user_id: session.userId ?? null,
    trigger_source: session.spawnSource ?? null,
    parent_session_id: session.parentSessionId ?? null,
    repo: repoScope ?? "No repository",
  };

  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    // Error (not warn): a missing token is a deployment misconfig and must reach alerting.
    logger.error("Slack notification denied: SLACK_BOT_TOKEN is not configured", {
      session_id: sessionId,
      reason: "feature_unavailable",
      channel_input: parsed.channel,
      request_reason: parsed.reason ?? null,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      ...audit,
    });
    return failureResponse("feature_unavailable", "Slack bot token is not configured.");
  }

  const settingsStore = new IntegrationSettingsStore(env.DB);
  const settings = repoScope
    ? (await settingsStore.getResolvedConfig("slack", repoScope)).settings
    : ((await settingsStore.getGlobal("slack"))?.defaults ?? {});
  const { agentNotificationsEnabled, mentionsPolicy } = resolveSlackSettings(
    settings as Partial<SlackGlobalSettings>
  );
  if (!agentNotificationsEnabled) {
    logDenial(sessionId, ctx, parsed, audit, "feature_disabled");
    return failureResponse(
      "feature_disabled",
      repoScope
        ? "Slack agent notifications are disabled for this repository."
        : "Slack agent notifications are disabled globally."
    );
  }

  const sanitized = sanitizeAgentText(parsed.text, {
    mentionsPolicy,
    maxLength: SLACK_TEXT_MAX_LENGTH,
  });

  if (sanitized.text.trim().length === 0) {
    logDenial(sessionId, ctx, parsed, audit, "empty_message_after_sanitization");
    return failureResponse(
      "empty_message_after_sanitization",
      "Message body is empty after sanitization."
    );
  }

  const blocks = buildBlocks({
    text: sanitized.text,
    sessionId,
    appName: env.APP_NAME ?? "Open-Inspect",
    webAppUrl: env.WEB_APP_URL,
  });

  const post = await postMessage(token, parsed.channel, sanitized.text, {
    thread_ts: parsed.threadTs,
    blocks,
  });

  if (!post.ok) {
    const reasonCode = mapSlackError(post.error);
    logDenial(sessionId, ctx, parsed, audit, reasonCode, post.retryAfter);
    return failureResponse(reasonCode, post.error, post.retryAfter);
  }

  const channelId = post.channel;
  const messageTs = post.ts;
  const permalinkResp = await getPermalink(token, channelId, messageTs);
  const permalink = permalinkResp.ok ? permalinkResp.permalink : "";

  const result: SlackNotifySuccessOutput = {
    ok: true,
    channelInput: parsed.channel,
    channelId,
    messageTs,
    permalink,
    truncated: sanitized.truncated,
    strippedBroadcasts: sanitized.strippedBroadcasts,
    mentionsModified: sanitized.mentionsModified,
  };

  logger.info("Slack notification posted", {
    event: "slack_notify.success",
    session_id: sessionId,
    channel_input: parsed.channel,
    channel_id: channelId,
    message_ts: messageTs,
    truncated: sanitized.truncated,
    stripped_broadcasts: sanitized.strippedBroadcasts,
    mentions_modified: sanitized.mentionsModified,
    request_reason: parsed.reason ?? null,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    ...audit,
  });

  return json(result);
}

async function parseBody(request: Request): Promise<ParsedBody | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return failureResponse("invalid_input", "Body must be valid JSON.");
  }

  if (raw === null || typeof raw !== "object") {
    return failureResponse("invalid_input", "Body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  const channelValue = typeof body.channel === "string" ? body.channel.trim() : "";
  if (channelValue.length === 0 || channelValue.length > CHANNEL_INPUT_MAX_LENGTH) {
    return failureResponse(
      "invalid_input",
      `channel must be 1..${CHANNEL_INPUT_MAX_LENGTH} characters.`
    );
  }
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length === 0) {
    return failureResponse("invalid_input", "text is required.");
  }
  if (text.length > RAW_TEXT_INPUT_MAX_LENGTH) {
    return failureResponse(
      "invalid_input",
      `text must be at most ${RAW_TEXT_INPUT_MAX_LENGTH} characters.`
    );
  }

  const threadTs =
    typeof body.thread_ts === "string" && body.thread_ts.length > 0 ? body.thread_ts : undefined;
  const rawReason = typeof body.reason === "string" ? body.reason : undefined;
  const reason = rawReason ? rawReason.slice(0, REASON_MAX_LENGTH) : undefined;

  return {
    channel: channelValue,
    text,
    threadTs,
    reason,
  };
}

function buildBlocks(opts: {
  text: string;
  sessionId: string;
  appName: string;
  webAppUrl: string | undefined;
}): unknown[] {
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: opts.text },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Posted by ${opts.appName} agent on behalf of a session.`,
        },
      ],
    },
  ];

  if (opts.webAppUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "View Session" },
          url: `${opts.webAppUrl.replace(/\/$/, "")}/session/${opts.sessionId}`,
        },
      ],
    });
  }

  return blocks;
}

function mapSlackError(slackError: string | undefined): SlackWireDenialReason {
  if (!slackError) return "slack_api_error";
  if (
    slackError === "channel_not_found" ||
    slackError === "not_in_channel" ||
    slackError === "is_archived"
  ) {
    return "channel_not_found_or_forbidden";
  }
  if (slackError === "ratelimited") return "rate_limited";
  return "slack_api_error";
}

function failureResponse(
  reason: SlackWireDenialReason,
  message: string | undefined,
  retryAfter?: number
): Response {
  const body: Record<string, unknown> = { error: reason };
  if (message) body.message = message;
  if (typeof retryAfter === "number") body.retryAfter = retryAfter;
  return json(body, SLACK_DENIAL_STATUS[reason]);
}

function logDenial(
  sessionId: string,
  ctx: RequestContext,
  parsed: ParsedBody,
  audit: AuditFields,
  reason: SlackWireDenialReason,
  retryAfter?: number
): void {
  logger.warn("Slack notification denied", {
    event: "slack_notify.denial",
    session_id: sessionId,
    reason,
    channel_input: parsed.channel,
    request_reason: parsed.reason ?? null,
    has_thread_ts: parsed.threadTs !== undefined,
    retry_after: retryAfter ?? null,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    ...audit,
  });
}
