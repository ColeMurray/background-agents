/**
 * Slack Web API client. The bot token is the first positional argument on
 * every method so that distinct workers (slack-bot, control-plane) can
 * supply their own token without sharing module-level state.
 *
 * Errors from the Slack API are returned as `{ ok: false, error }` envelopes;
 * HTTP-level failures (4xx/5xx, network errors, malformed bodies) are
 * mapped into the same envelope shape so callers never need to catch.
 */

import { z } from "zod";
import { computeHmacHex, timingSafeEqual } from "../auth";

const SLACK_API_BASE = "https://slack.com/api";
export const SLACK_REQUEST_TIMEOUT_MS = 10_000;
export const SLACK_PAGINATION_TIMEOUT_MS = 30_000;

/**
 * Discriminated success/failure envelope returned by every Slack API method.
 *
 * The success arm is `{ ok: true } & T`; the failure arm carries an `error`
 * string (Slack's `error` field, or one of the synthesized values
 * `network_error` / `timeout` / `cancelled` / `delivery_unknown` /
 * `invalid_response` / `http_<status>` / `ratelimited`).
 *
 * `T` is never supplied by hand: each endpoint passes a schema for its success
 * payload and `T` is inferred from it, so the type a caller reads and the shape
 * validated at the boundary cannot drift apart.
 */
export type SlackEnvelope<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; retryAfter?: number };

const slackFailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  retryAfter: z.number().optional(),
});

/**
 * Compose an endpoint's success-payload schema with the shared `ok`
 * discriminator into the schema for a whole Slack response.
 *
 * Validating the payload here is what makes the success arm honest: a body like
 * `{ ok: true }` from an endpoint that promises `channels` fails the schema and
 * is reported as `invalid_response` at the boundary, rather than being handed
 * to a caller that would iterate a missing array.
 */
function slackEnvelopeSchema<S extends z.ZodType<object>>(payload: S) {
  return z.union([z.intersection(z.object({ ok: z.literal(true) }), payload), slackFailureSchema]);
}

/** Success payload for endpoints whose response carries no field callers read. */
const noPayloadSchema = z.object({});

export interface ExternalUploadUrlOptions {
  filename: string;
  length: number;
  altText?: string;
  signal?: AbortSignal;
}

export interface CompleteExternalUploadOptions {
  files: Array<{ id: string; title?: string }>;
  channelId: string;
  threadTs: string;
  signal?: AbortSignal;
}

export interface SlackRequestOptions {
  signal?: AbortSignal;
}

function boundedSignal(signal?: AbortSignal, timeoutMs = SLACK_REQUEST_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function requestError(
  signal: AbortSignal,
  method: "GET" | "POST"
): "timeout" | "cancelled" | "delivery_unknown" | "network_error" {
  if (!signal.aborted) return "network_error";
  if (method === "POST") return "delivery_unknown";
  return signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
    ? "timeout"
    : "cancelled";
}

async function slackFetch<S extends z.ZodType<object>>(
  token: string,
  endpoint: string,
  method: "GET" | "POST",
  payload: S,
  init?: { query?: Record<string, string>; body?: Record<string, unknown>; signal?: AbortSignal }
): Promise<SlackEnvelope<z.infer<S>>> {
  const url = init?.query
    ? `${SLACK_API_BASE}/${endpoint}?${new URLSearchParams(init.query).toString()}`
    : `${SLACK_API_BASE}/${endpoint}`;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (init?.body) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const signal = boundedSignal(init?.signal);
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal });
  } catch {
    return { ok: false, error: requestError(signal, method) };
  }

  if (response.status === 429) {
    const retryHeader = response.headers.get("retry-after");
    const parsed = retryHeader ? parseInt(retryHeader, 10) : NaN;
    return {
      ok: false,
      error: "ratelimited",
      ...(Number.isFinite(parsed) ? { retryAfter: parsed } : {}),
    };
  }

  if (!response.ok) {
    return { ok: false, error: `http_${response.status}` };
  }

  try {
    const parsed = slackEnvelopeSchema(payload).safeParse(await response.json());
    return parsed.success ? parsed.data : { ok: false, error: "invalid_response" };
  } catch {
    return {
      ok: false,
      error: signal.aborted ? requestError(signal, method) : "invalid_response",
    };
  }
}

function slackGet<S extends z.ZodType<object>>(
  token: string,
  endpoint: string,
  payload: S,
  query?: Record<string, string>,
  signal?: AbortSignal
): Promise<SlackEnvelope<z.infer<S>>> {
  return slackFetch(token, endpoint, "GET", payload, query ? { query, signal } : { signal });
}

function slackPost<S extends z.ZodType<object>>(
  token: string,
  endpoint: string,
  payload: S,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<SlackEnvelope<z.infer<S>>> {
  return slackFetch(token, endpoint, "POST", payload, body ? { body, signal } : { signal });
}

const uploadUrlPayloadSchema = z.object({ upload_url: z.string(), file_id: z.string() });

export function getExternalUploadUrl(
  token: string,
  options: ExternalUploadUrlOptions
): Promise<SlackEnvelope<{ upload_url: string; file_id: string }>> {
  return slackGet(
    token,
    "files.getUploadURLExternal",
    uploadUrlPayloadSchema,
    {
      filename: options.filename,
      length: String(options.length),
      ...(options.altText ? { alt_txt: options.altText } : {}),
    },
    options.signal
  );
}

export async function uploadToExternalUrl(
  uploadUrl: string,
  body: RequestInit["body"],
  contentType: string,
  signal?: AbortSignal
): Promise<SlackEnvelope> {
  const boundedRequestSignal = boundedSignal(signal);
  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal: boundedRequestSignal,
    });
    return response.ok ? { ok: true } : { ok: false, error: `http_${response.status}` };
  } catch {
    return { ok: false, error: requestError(boundedRequestSignal, "POST") };
  }
}

const completeUploadPayloadSchema = z.object({
  files: z.array(z.object({ id: z.string(), title: z.string().optional() })),
});

export function completeExternalUpload(
  token: string,
  options: CompleteExternalUploadOptions
): Promise<SlackEnvelope<{ files: Array<{ id: string; title?: string }> }>> {
  return slackPost(
    token,
    "files.completeUploadExternal",
    completeUploadPayloadSchema,
    {
      files: options.files,
      channel_id: options.channelId,
      thread_ts: options.threadTs,
    },
    options.signal
  );
}

/**
 * Verify a Slack request signature using the Web Crypto API.
 *
 * Enforces a 5-minute replay-attack window on the timestamp.
 */
export async function verifySlackSignature(
  signature: string | null,
  timestamp: string | null,
  body: string,
  signingSecret: string
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) {
    return false;
  }

  const baseString = `v0:${timestamp}:${body}`;
  const hashHex = await computeHmacHex(baseString, signingSecret);
  const expectedSignature = `v0=${hashHex}`;

  return timingSafeEqual(signature, expectedSignature);
}

/**
 * `chat.postMessage` identifies the message it created; callers thread replies
 * and edits off both fields, so a success arm missing either is not usable.
 */
const postedMessagePayloadSchema = z.object({ channel: z.string(), ts: z.string() });

export function postMessage(
  token: string,
  channel: string,
  text: string,
  options?: {
    thread_ts?: string;
    blocks?: unknown[];
    reply_broadcast?: boolean;
  }
): Promise<SlackEnvelope<{ channel: string; ts: string }>> {
  return slackPost(token, "chat.postMessage", postedMessagePayloadSchema, {
    channel,
    text,
    thread_ts: options?.thread_ts,
    blocks: options?.blocks,
    reply_broadcast: options?.reply_broadcast,
  });
}

export function postBlocks(
  token: string,
  channel: string,
  blocks: unknown[],
  options?: {
    thread_ts?: string;
    reply_broadcast?: boolean;
    signal?: AbortSignal;
  }
): Promise<SlackEnvelope<{ channel: string; ts: string }>> {
  return slackPost(
    token,
    "chat.postMessage",
    postedMessagePayloadSchema,
    {
      channel,
      blocks,
      thread_ts: options?.thread_ts,
      reply_broadcast: options?.reply_broadcast,
    },
    options?.signal
  );
}

const permalinkPayloadSchema = z.object({ permalink: z.string(), channel: z.string() });

export function getPermalink(
  token: string,
  channel: string,
  messageTs: string,
  options?: SlackRequestOptions
): Promise<SlackEnvelope<{ permalink: string; channel: string }>> {
  return slackGet(
    token,
    "chat.getPermalink",
    permalinkPayloadSchema,
    {
      channel,
      message_ts: messageTs,
    },
    options?.signal
  );
}

/**
 * Post an ephemeral message visible only to `user` in `channel` (optionally
 * threaded). Used to surface best-effort notices — e.g. "a run is already
 * active for this thread" — without adding noise for everyone else.
 */
const ephemeralPayloadSchema = z.object({ message_ts: z.string() });

export function postEphemeral(
  token: string,
  channel: string,
  user: string,
  text: string,
  options?: { thread_ts?: string; blocks?: unknown[] }
): Promise<SlackEnvelope<{ message_ts: string }>> {
  return slackPost(token, "chat.postEphemeral", ephemeralPayloadSchema, {
    channel,
    user,
    text,
    thread_ts: options?.thread_ts,
    blocks: options?.blocks,
  });
}

export function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string,
  options?: { blocks?: unknown[] }
): Promise<SlackEnvelope> {
  return slackPost(token, "chat.update", noPayloadSchema, {
    channel,
    ts,
    text,
    blocks: options?.blocks,
  });
}

export function addReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<SlackEnvelope> {
  return slackPost(token, "reactions.add", noPayloadSchema, {
    channel,
    timestamp: messageTs,
    name,
  });
}

export function removeReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<SlackEnvelope> {
  return slackPost(token, "reactions.remove", noPayloadSchema, {
    channel,
    timestamp: messageTs,
    name,
  });
}

/** Subset of the `auth.test` response the bot uses to learn its own identity. */
const authTestPayloadSchema = z.object({
  user_id: z.string(),
  user: z.string().optional(),
  team_id: z.string().optional(),
  team: z.string().optional(),
  bot_id: z.string().optional(),
});

export type SlackAuthTestResult = z.infer<typeof authTestPayloadSchema>;

/**
 * Call `auth.test` to resolve the identity of the token's bot user. The
 * slack-bot uses the returned `user_id` to strip and suppress its own mentions.
 */
export function authTest(token: string): Promise<SlackEnvelope<SlackAuthTestResult>> {
  return slackPost(token, "auth.test", authTestPayloadSchema);
}

const slackChannelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  topic: z.object({ value: z.string() }).optional(),
  purpose: z.object({ value: z.string() }).optional(),
});

export type SlackChannelInfo = z.infer<typeof slackChannelInfoSchema>;

const channelInfoPayloadSchema = z.object({ channel: slackChannelInfoSchema });

export function getChannelInfo(
  token: string,
  channelId: string
): Promise<SlackEnvelope<{ channel: SlackChannelInfo }>> {
  return slackGet(token, "conversations.info", channelInfoPayloadSchema, { channel: channelId });
}

/** Raw `conversations.list` page (the channel fields the picker consumes). */
const conversationsListPayloadSchema = z.object({
  channels: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      is_private: z.boolean().optional(),
      is_member: z.boolean().optional(),
    })
  ),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

/** Normalized channel for the automation channel picker. */
export interface SlackChannelListing {
  id: string;
  name: string;
  isPrivate: boolean;
  /** Whether the bot is a member — only member channels deliver messages. */
  isMember: boolean;
}

/**
 * List the workspace's public + private channels via `conversations.list`,
 * following `response_metadata.next_cursor` pagination and excluding archived
 * channels. Requires the bot token's `channels:read` (public) and `groups:read`
 * (private) scopes. Returns the SlackEnvelope failure arm on any page's error.
 */
export async function listChannels(
  token: string,
  options?: SlackRequestOptions
): Promise<SlackEnvelope<{ channels: SlackChannelListing[] }>> {
  const paginationSignal = boundedSignal(options?.signal, SLACK_PAGINATION_TIMEOUT_MS);
  const channels: SlackChannelListing[] = [];
  let cursor: string | undefined;
  // Bound the loop defensively: 1000/page × 20 pages caps at 20k channels.
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = {
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "1000",
    };
    if (cursor) query.cursor = cursor;

    const res = await slackGet(
      token,
      "conversations.list",
      conversationsListPayloadSchema,
      query,
      paginationSignal
    );
    if (!res.ok) return res;

    for (const c of res.channels) {
      channels.push({
        id: c.id,
        name: c.name,
        isPrivate: Boolean(c.is_private),
        isMember: Boolean(c.is_member),
      });
    }

    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { ok: true, channels };
}

const slackThreadMessageSchema = z.object({
  ts: z.string(),
  text: z.string(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
});

export type SlackThreadMessage = z.infer<typeof slackThreadMessageSchema>;

const conversationsRepliesPayloadSchema = z.object({
  messages: z.array(slackThreadMessageSchema),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

/**
 * Fetch a thread's replies via `conversations.replies`, following
 * `response_metadata.next_cursor` pagination so long threads are collected in
 * full rather than truncated to Slack's first (oldest) page. Pass `oldest` to
 * restrict the window to messages posted after that ts. Messages are returned
 * oldest-first. Returns the SlackEnvelope failure arm on any page's error.
 */
export async function getThreadMessages(
  token: string,
  channelId: string,
  threadTs: string,
  oldest?: string,
  options?: SlackRequestOptions
): Promise<SlackEnvelope<{ messages: SlackThreadMessage[] }>> {
  const paginationSignal = boundedSignal(options?.signal, SLACK_PAGINATION_TIMEOUT_MS);
  const messages: SlackThreadMessage[] = [];
  let cursor: string | undefined;
  // Bound the loop defensively: 200/page × 25 pages caps at 5k messages.
  for (let page = 0; page < 25; page++) {
    const query: Record<string, string> = {
      channel: channelId,
      ts: threadTs,
      limit: "200",
    };
    if (oldest) query.oldest = oldest;
    if (cursor) query.cursor = cursor;

    const res = await slackGet(
      token,
      "conversations.replies",
      conversationsRepliesPayloadSchema,
      query,
      paginationSignal
    );
    if (!res.ok) return res;

    messages.push(...res.messages);
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { ok: true, messages };
}

/**
 * A file object as it appears on a Slack message (subset of fields we use).
 *
 * The schema is the source of truth: `SlackMessageFile` is inferred from it and
 * inbound-event validation reuses it, so adding a field here reaches both the
 * type and the trust boundary at once.
 */
export const slackMessageFileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
  size: z.number().optional(),
  /** "external" marks remote files whose url_private is third-party-hosted. */
  mode: z.string().optional(),
});

export type SlackMessageFile = z.infer<typeof slackMessageFileSchema>;

/**
 * A secondary attachment on a Slack message (subset of fields we use).
 *
 * Two very different things arrive in this array. Sharing or forwarding a
 * message produces a *message* attachment flagged `is_share` (and may also set
 * `is_msg_unfurl`), carrying the shared message's author and body — which is the
 * only place that body exists on the new message. A pasted Slack message link
 * produces an attachment with `is_msg_unfurl` but not `is_share`. Callers that
 * read message bodies must use `is_share` as the positive discriminator.
 */
export const slackMessageAttachmentSchema = z.object({
  /** Set when the attachment is a shared/forwarded Slack message. */
  is_share: z.boolean().optional(),
  /** Set when the attachment unfurls a Slack message permalink. */
  is_msg_unfurl: z.boolean().optional(),
  /** Body of the shared message, in mrkdwn. */
  text: z.string().optional(),
  /** Plain-text rendering Slack always provides, e.g. "[date] user: body". */
  fallback: z.string().optional(),
  /** Display name of the shared message's author. */
  author_name: z.string().optional(),
  /** Channel the shared message came from; absent when Slack omits it. */
  channel_name: z.string().optional(),
  /** Id of the channel the shared message came from. */
  channel_id: z.string().optional(),
  /** Slack ts of the shared message, i.e. its identity within the channel. */
  ts: z.string().optional(),
  /** Permalink of the shared message. */
  from_url: z.string().optional(),
  /** Files the shared message carried, Slack-hosted like any message file. */
  files: z.array(slackMessageFileSchema).optional(),
});

export type SlackMessageAttachment = z.infer<typeof slackMessageAttachmentSchema>;

/**
 * A one-message window from `conversations.history` / `conversations.replies`.
 *
 * Only `ts` is needed to pick the target out of the window; `files` and
 * `attachments` are absent on messages that carry neither.
 */
const messageWindowPayloadSchema = z.object({
  messages: z.array(
    z.object({
      ts: z.string(),
      files: z.array(slackMessageFileSchema).optional(),
      attachments: z.array(slackMessageAttachmentSchema).optional(),
    })
  ),
});

/**
 * Fetch the files and attachments on a single message.
 *
 * `app_mention` events don't include the message's `files` array — and may omit
 * `attachments` too — so when an event arrives without them we recover them
 * from conversation history. Pass `threadTs` when the message is a thread
 * reply; otherwise the top-level message at `ts` is fetched. Returns the
 * failure arm on API errors so callers can distinguish "the message has none"
 * from "the lookup failed".
 */
export async function getMessageDetails(
  token: string,
  channelId: string,
  ts: string,
  threadTs?: string
): Promise<SlackEnvelope<{ files: SlackMessageFile[]; attachments: SlackMessageAttachment[] }>> {
  // Single-message fetch. The two endpoints sort differently, so the window
  // anchor differs: conversations.history returns newest-first, so
  // `latest=<ts>&inclusive=true&limit=1` yields the target; conversations.replies
  // returns oldest-first, so the anchor must be `oldest=<ts>&inclusive=true` (a
  // `latest` anchor would yield the thread root instead). Never set oldest and
  // latest to the same ts — an equal pair is a zero-width window that Slack
  // returns empty for. `limit=2` on replies tolerates the thread root being
  // included alongside the target; the find-by-ts below is the source of truth.
  const res =
    threadTs && threadTs !== ts
      ? await slackGet(token, "conversations.replies", messageWindowPayloadSchema, {
          channel: channelId,
          ts: threadTs,
          oldest: ts,
          inclusive: "true",
          limit: "2",
        })
      : await slackGet(token, "conversations.history", messageWindowPayloadSchema, {
          channel: channelId,
          latest: ts,
          inclusive: "true",
          limit: "1",
        });
  if (!res.ok) return res;
  const message = res.messages.find((m) => m.ts === ts);
  return { ok: true, files: message?.files ?? [], attachments: message?.attachments ?? [] };
}

const slackUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
  profile: z
    .object({
      display_name: z.string().optional(),
      real_name: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
});

export type SlackUser = z.infer<typeof slackUserSchema>;

const userInfoPayloadSchema = z.object({ user: slackUserSchema });

export function getUserInfo(
  token: string,
  userId: string
): Promise<SlackEnvelope<{ user: SlackUser }>> {
  return slackGet(token, "users.info", userInfoPayloadSchema, { user: userId });
}

export function publishView(
  token: string,
  userId: string,
  view: Record<string, unknown>
): Promise<SlackEnvelope> {
  return slackPost(token, "views.publish", noPayloadSchema, { user_id: userId, view });
}

export function openView(
  token: string,
  triggerId: string,
  view: Record<string, unknown>
): Promise<SlackEnvelope> {
  return slackPost(token, "views.open", noPayloadSchema, { trigger_id: triggerId, view });
}
