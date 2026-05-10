/**
 * Agent-initiated Slack notification handler.
 *
 * The sandbox calls this endpoint via its bearer token; the control plane
 * authorizes (master switch + sanitization), forwards the agent's channel
 * verbatim to Slack, and emits tool_call/tool_result events so the post is
 * visible in the session transcript.
 */

import {
  getPermalink,
  postMessage,
  sanitizeAgentText,
  type MentionPolicy,
  type SlackGlobalSettings,
} from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { IntegrationSettingsStore } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { createLogger } from "../logger";
import { buildSessionInternalUrl, SessionInternalPaths } from "../session/contracts";
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
const DEFAULT_MENTIONS_POLICY: MentionPolicy = "allow";
const SYNTHETIC_SANDBOX_ID = "control-plane";

type DenialReason =
  | "feature_unavailable"
  | "feature_disabled"
  | "empty_message_after_sanitization"
  | "channel_not_found_or_forbidden"
  | "rate_limited"
  | "slack_api_error"
  | "invalid_input";

const STATUS_FOR_REASON: Record<DenialReason, number> = {
  feature_unavailable: 503,
  feature_disabled: 403,
  empty_message_after_sanitization: 422,
  channel_not_found_or_forbidden: 404,
  rate_limited: 429,
  slack_api_error: 502,
  invalid_input: 400,
};

interface ParsedBody {
  channel: string;
  text: string;
  threadTs: string | undefined;
  reason: string | undefined;
}

interface Attribution {
  promptAuthorUserId: string | null;
  triggerSource: string | null;
  parentSessionId: string | null;
  repo: string;
}

interface SuccessOutput {
  ok: true;
  channelInput: string;
  channelId: string;
  messageTs: string;
  permalink: string;
  truncated: boolean;
  strippedBroadcasts: boolean;
  mentionsModified: boolean;
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

  const repo = `${session.repoOwner}/${session.repoName}`;
  const attribution: Attribution = {
    promptAuthorUserId: session.userId ?? null,
    triggerSource: session.spawnSource ?? null,
    parentSessionId: session.parentSessionId ?? null,
    repo,
  };

  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    await emitDenial(env, sessionId, ctx, parsed, attribution, "feature_unavailable");
    return failureResponse("feature_unavailable", "Slack bot token is not configured.");
  }

  const settingsStore = new IntegrationSettingsStore(env.DB);
  const { settings } = await settingsStore.getResolvedConfig("slack", repo);
  const slackSettings = settings as Partial<SlackGlobalSettings>;
  if (slackSettings.agentNotificationsEnabled !== true) {
    await emitDenial(env, sessionId, ctx, parsed, attribution, "feature_disabled");
    return failureResponse(
      "feature_disabled",
      "Slack agent notifications are disabled for this repository."
    );
  }

  const mentionsPolicy = (slackSettings.mentionsPolicy ?? DEFAULT_MENTIONS_POLICY) as MentionPolicy;
  const sanitized = sanitizeAgentText(parsed.text, {
    mentionsPolicy,
    maxLength: SLACK_TEXT_MAX_LENGTH,
  });

  if (sanitized.text.trim().length === 0) {
    await emitDenial(env, sessionId, ctx, parsed, attribution, "empty_message_after_sanitization");
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
    await emitDenial(env, sessionId, ctx, parsed, attribution, reasonCode, post.retryAfter);
    return failureResponse(reasonCode, post.error, post.retryAfter);
  }

  const channelId = post.channel ?? parsed.channel;
  const messageTs = post.ts ?? "";
  const permalinkResp = await getPermalink(token, channelId, messageTs).catch(() => ({
    ok: false as const,
    permalink: undefined as string | undefined,
  }));
  const permalink = permalinkResp.ok && permalinkResp.permalink ? permalinkResp.permalink : "";

  const result: SuccessOutput = {
    ok: true,
    channelInput: parsed.channel,
    channelId,
    messageTs,
    permalink,
    truncated: sanitized.truncated,
    strippedBroadcasts: sanitized.strippedBroadcasts,
    mentionsModified: sanitized.mentionsModified,
  };

  const callId = generateId();
  await emitToolEvent(env, sessionId, ctx, {
    type: "tool_call",
    tool: "slack-notify",
    args: {
      channel: parsed.channel,
      text: parsed.text,
      thread_ts: parsed.threadTs,
      reason: parsed.reason,
    },
    callId,
    status: "completed",
    output: JSON.stringify({ ...result, attribution }),
    sandboxId: SYNTHETIC_SANDBOX_ID,
    timestamp: Date.now() / 1000,
  });

  await emitToolEvent(env, sessionId, ctx, {
    type: "tool_result",
    callId,
    result: JSON.stringify(result),
    sandboxId: SYNTHETIC_SANDBOX_ID,
    timestamp: Date.now() / 1000,
  });

  logger.info("Slack notification posted", {
    event: "slack_notify.success",
    session_id: sessionId,
    repo,
    channel_input: parsed.channel,
    channel_id: channelId,
    message_ts: messageTs,
    truncated: sanitized.truncated,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
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

function mapSlackError(slackError: string | undefined): DenialReason {
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
  reason: DenialReason,
  message: string | undefined,
  retryAfter?: number
): Response {
  const body: Record<string, unknown> = { error: reason };
  if (message) body.message = message;
  if (typeof retryAfter === "number") body.retryAfter = retryAfter;
  return json(body, STATUS_FOR_REASON[reason]);
}

async function emitDenial(
  env: Env,
  sessionId: string,
  ctx: RequestContext,
  parsed: ParsedBody,
  attribution: Attribution,
  reason: DenialReason,
  retryAfter?: number
): Promise<void> {
  await emitToolEvent(env, sessionId, ctx, {
    type: "tool_call",
    tool: "slack-notify",
    args: {
      channel: parsed.channel,
      text: parsed.text,
      thread_ts: parsed.threadTs,
      reason: parsed.reason,
    },
    callId: generateId(),
    status: "error",
    output: reason,
    sandboxId: SYNTHETIC_SANDBOX_ID,
    timestamp: Date.now() / 1000,
    attribution,
    retryAfter,
  });
}

async function emitToolEvent(
  env: Env,
  sessionId: string,
  ctx: RequestContext,
  payload: Record<string, unknown>
): Promise<void> {
  const doId = env.SESSION.idFromName(sessionId);
  const stub = env.SESSION.get(doId);
  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("x-trace-id", ctx.trace_id);
  headers.set("x-request-id", ctx.request_id);
  try {
    await stub.fetch(
      new Request(buildSessionInternalUrl(SessionInternalPaths.sandboxEvent), {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      })
    );
  } catch (err) {
    logger.warn("Failed to emit slack-notify tool event", {
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
  }
}
