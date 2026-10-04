import { Hono } from "hono";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
/**
 * Intentionally emits no transcript events: the agent's own tool_call event
 * is the single source of truth. Audit detail lives in the structured logs.
 */

import {
  getPermalink,
  listChannels,
  postBlocks,
  sanitizeAgentText,
  splitIntoSlackSections,
  SLACK_DENIAL_STATUS,
  type SlackNotifySuccessOutput,
  type SlackWireDenialReason,
} from "@open-inspect/shared/slack";
import type { SlackGlobalSettings } from "@open-inspect/shared/types/integrations";
import { IntegrationSettingsStore, resolveSlackSettings } from "../db/integration-settings";
import { SessionIndexStore } from "../db/session-index";
import { TeamChannelBindingStore } from "../db/team-channel-bindings";
import { slackPostGate } from "../authorization/slack-post-gate";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { GITHUB_SANDBOX_FALLBACK_ROUTE, json, requireSession, type RequestContext } from "./shared";

const logger = createLogger("slack-notify");

/**
 * Hard cap on the raw text we accept and persist verbatim in event args. Also
 * the sanitizer's ceiling: text longer than one Slack section is split across
 * consecutive sections rather than cut, so the section limit is not a limit on
 * what an agent may post.
 */
const RAW_TEXT_INPUT_MAX_LENGTH = 12_000;
/** Channel name length cap (Slack max is 80). */
const CHANNEL_INPUT_MAX_LENGTH = 80;
/** Reason field cap; recorded for audit only. */
const REASON_MAX_LENGTH = 500;
const CHANNEL_NAME_CACHE_TTL_MS = 60_000;
const CHANNEL_NAME_CACHE_MAX_ENTRIES = 1_000;
const channelNameCache = new Map<string, { id: string; expiresAt: number }>();

function cacheChannelName(token: string, channel: { id: string; name: string }, expiresAt: number) {
  const key = JSON.stringify([token, channel.name.toLowerCase()]);
  channelNameCache.delete(key);
  channelNameCache.set(key, { id: channel.id, expiresAt });
  if (channelNameCache.size > CHANNEL_NAME_CACHE_MAX_ENTRIES) {
    const oldestKey = channelNameCache.keys().next().value;
    if (oldestKey !== undefined) channelNameCache.delete(oldestKey);
  }
}

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
  repo: string | null;
}

export async function handleSlackNotify(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: RequestContext
): Promise<Response> {
  const sessionId = params.id;

  const parsed = await parseBody(request);
  if (parsed instanceof Response) return parsed;

  const sessionStore = new SessionIndexStore(ctx.db);
  const session = await sessionStore.get(sessionId);
  if (!session) {
    return failureResponse("invalid_input", "Session not found.");
  }

  const repoScope =
    session.repoOwner && session.repoName ? `${session.repoOwner}/${session.repoName}` : null;
  const audit: AuditFields = {
    prompt_author_user_id: session.userId ?? null,
    trigger_source: session.spawnSource ?? null,
    parent_session_id: session.parentSessionId ?? null,
    repo: repoScope,
  };

  // The target binding is unknown until channel name resolution below.
  if (session.visibility === "private") {
    logDenial(sessionId, ctx, parsed, audit, "session_scope_denied");
    return failureResponse("session_scope_denied", "This session cannot post to Slack.");
  }

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

  const settingsStore = new IntegrationSettingsStore(ctx.db);
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
    maxLength: RAW_TEXT_INPUT_MAX_LENGTH,
  });

  if (sanitized.text.trim().length === 0) {
    logDenial(sessionId, ctx, parsed, audit, "empty_message_after_sanitization");
    return failureResponse(
      "empty_message_after_sanitization",
      "Message body is empty after sanitization."
    );
  }

  let targetChannelId = parsed.channel;
  if (!/^[CDG][A-Z0-9]+$/.test(targetChannelId)) {
    const name = parsed.channel.replace(/^#/, "").toLowerCase();
    const cacheKey = JSON.stringify([token, name]);
    const cached = channelNameCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      targetChannelId = cached.id;
    } else {
      channelNameCache.delete(cacheKey);
      const listing = await listChannels(token, { signal: request.signal });
      if (!listing.ok) {
        const reason = mapSlackError(listing.error);
        logDenial(sessionId, ctx, parsed, audit, reason, listing.retryAfter);
        return failureResponse(reason, listing.error, listing.retryAfter);
      }
      const expiresAt = Date.now() + CHANNEL_NAME_CACHE_TTL_MS;
      for (const channel of listing.channels) cacheChannelName(token, channel, expiresAt);
      const channel = listing.channels.find((candidate) => candidate.name.toLowerCase() === name);
      if (!channel) {
        logDenial(sessionId, ctx, parsed, audit, "channel_not_found_or_forbidden");
        return failureResponse("channel_not_found_or_forbidden", "Slack channel was not found.");
      }
      // A large listing must not evict the name this request actually resolved.
      cacheChannelName(token, channel, expiresAt);
      targetChannelId = channel.id;
    }
  }

  // Re-read after name resolution: only the authoritative, current row permits publication.
  const [currentSession, channelBinding] = await Promise.all([
    sessionStore.get(sessionId),
    new TeamChannelBindingStore(ctx.db).get("slack", targetChannelId),
  ]);
  if (slackPostGate(currentSession, channelBinding)) {
    logDenial(sessionId, ctx, parsed, audit, "session_scope_denied");
    return failureResponse(
      "session_scope_denied",
      "This session cannot post to this Slack channel."
    );
  }

  const sections = splitIntoSlackSections(sanitized.text);
  const blocks = buildBlocks({
    sections,
    sessionId,
    appName: env.APP_NAME ?? "Open-Inspect",
    webAppUrl: env.WEB_APP_URL,
  });
  // Without top-level text, Slack derives screen-reader text from the blocks.
  const post = await postBlocks(token, targetChannelId, blocks, {
    thread_ts: parsed.threadTs,
    signal: request.signal,
  });

  if (!post.ok) {
    const reasonCode = mapSlackError(post.error);
    logDenial(sessionId, ctx, parsed, audit, reasonCode, post.retryAfter);
    return failureResponse(reasonCode, post.error, post.retryAfter);
  }

  const channelId = post.channel;
  const messageTs = post.ts;
  const permalinkResp = await getPermalink(token, channelId, messageTs, { signal: request.signal });
  const permalink = permalinkResp.ok ? permalinkResp.permalink : "";

  const result: SlackNotifySuccessOutput = {
    ok: true,
    channelInput: parsed.channel,
    channelId,
    messageTs,
    permalink,
    // Only the raw-input cap can truncate now: the splitter's own ceiling
    // (MAX_RESPONSE_SECTIONS sections) is far above RAW_TEXT_INPUT_MAX_LENGTH,
    // and text that merely exceeds one section is split rather than cut.
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
  sections: string[];
  sessionId: string;
  appName: string;
  webAppUrl: string | undefined;
}): unknown[] {
  const blocks: unknown[] = [
    ...opts.sections.map((section) => ({
      type: "section",
      text: { type: "mrkdwn", text: section },
    })),
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
  if (slackError === "delivery_unknown") return "delivery_unknown";
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

export const slackNotifyRoutes = new Hono<ControlPlaneHonoEnv>();

// Agent-initiated Slack notification (sandbox-authenticated).
slackNotifyRoutes.post(
  "/sessions/:id/slack-notify",
  admit({
    ...GITHUB_SANDBOX_FALLBACK_ROUTE,
    authorization: requireSession("collaborate"),
  }),
  (c) => dispatch(c, handleSlackNotify)
);
