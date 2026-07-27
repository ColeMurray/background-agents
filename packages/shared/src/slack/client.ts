/**
 * Slack Web API client. The bot token is the first positional argument on
 * every method so that distinct workers (slack-bot, control-plane) can
 * supply their own token without sharing module-level state.
 *
 * Errors from the Slack API are returned as `{ ok: false, error }` envelopes;
 * HTTP-level failures (4xx/5xx, network errors, malformed bodies) are
 * mapped into the same envelope shape so callers never need to catch.
 */

import { computeHmacHex, timingSafeEqual } from "../auth";

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Discriminated success/failure envelope returned by every Slack API method.
 *
 * The success arm is `{ ok: true } & T`; the failure arm carries an `error`
 * string (Slack's `error` field, or one of the synthesized values
 * `network_error` / `invalid_response` / `http_<status>` / `ratelimited`).
 */
export type SlackEnvelope<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; retryAfter?: number };

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

async function slackFetch<T>(
  token: string,
  endpoint: string,
  method: "GET" | "POST",
  init?: { query?: Record<string, string>; body?: Record<string, unknown>; signal?: AbortSignal }
): Promise<SlackEnvelope<T>> {
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

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, signal: init?.signal });
  } catch {
    return { ok: false, error: "network_error" };
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
    return (await response.json()) as SlackEnvelope<T>;
  } catch {
    return { ok: false, error: "invalid_response" };
  }
}

function slackGet<T>(
  token: string,
  endpoint: string,
  query?: Record<string, string>,
  signal?: AbortSignal
): Promise<SlackEnvelope<T>> {
  return slackFetch<T>(token, endpoint, "GET", query ? { query, signal } : { signal });
}

function slackPost<T>(
  token: string,
  endpoint: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<SlackEnvelope<T>> {
  return slackFetch<T>(token, endpoint, "POST", body ? { body, signal } : { signal });
}

export function getExternalUploadUrl(
  token: string,
  options: ExternalUploadUrlOptions
): Promise<SlackEnvelope<{ upload_url: string; file_id: string }>> {
  return slackGet(
    token,
    "files.getUploadURLExternal",
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
  try {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body,
      signal,
    });
    return response.ok ? { ok: true } : { ok: false, error: `http_${response.status}` };
  } catch {
    return { ok: false, error: "network_error" };
  }
}

export function completeExternalUpload(
  token: string,
  options: CompleteExternalUploadOptions
): Promise<SlackEnvelope<{ files: Array<{ id: string; title?: string }> }>> {
  return slackPost(
    token,
    "files.completeUploadExternal",
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
  return slackPost(token, "chat.postMessage", {
    channel,
    text,
    thread_ts: options?.thread_ts,
    blocks: options?.blocks,
    reply_broadcast: options?.reply_broadcast,
  });
}

export function getPermalink(
  token: string,
  channel: string,
  messageTs: string
): Promise<SlackEnvelope<{ permalink: string; channel: string }>> {
  return slackGet(token, "chat.getPermalink", { channel, message_ts: messageTs });
}

/**
 * Post an ephemeral message visible only to `user` in `channel` (optionally
 * threaded). Used to surface best-effort notices — e.g. "a run is already
 * active for this thread" — without adding noise for everyone else.
 */
export function postEphemeral(
  token: string,
  channel: string,
  user: string,
  text: string,
  options?: { thread_ts?: string; blocks?: unknown[] }
): Promise<SlackEnvelope<{ message_ts: string }>> {
  return slackPost(token, "chat.postEphemeral", {
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
  return slackPost(token, "chat.update", {
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
  return slackPost(token, "reactions.add", { channel, timestamp: messageTs, name });
}

export function removeReaction(
  token: string,
  channel: string,
  messageTs: string,
  name: string
): Promise<SlackEnvelope> {
  return slackPost(token, "reactions.remove", { channel, timestamp: messageTs, name });
}

/** Subset of the `auth.test` response the bot uses to learn its own identity. */
export interface SlackAuthTestResult {
  user_id: string;
  user?: string;
  team_id?: string;
  team?: string;
  bot_id?: string;
}

/**
 * Call `auth.test` to resolve the identity of the token's bot user. The
 * slack-bot uses the returned `user_id` to strip and suppress its own mentions.
 */
export function authTest(token: string): Promise<SlackEnvelope<SlackAuthTestResult>> {
  return slackPost(token, "auth.test");
}

export interface SlackChannelInfo {
  id: string;
  name: string;
  topic?: { value: string };
  purpose?: { value: string };
}

export function getChannelInfo(
  token: string,
  channelId: string
): Promise<SlackEnvelope<{ channel: SlackChannelInfo }>> {
  return slackGet(token, "conversations.info", { channel: channelId });
}

/** Raw `conversations.list` channel shape (subset the picker consumes). */
interface SlackConversation {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
}

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
  token: string
): Promise<SlackEnvelope<{ channels: SlackChannelListing[] }>> {
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

    const res = await slackGet<{
      channels: SlackConversation[];
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.list", query);
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

export interface SlackThreadMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
}

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
  oldest?: string
): Promise<SlackEnvelope<{ messages: SlackThreadMessage[] }>> {
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

    const res = await slackGet<{
      messages: SlackThreadMessage[];
      response_metadata?: { next_cursor?: string };
    }>(token, "conversations.replies", query);
    if (!res.ok) return res;

    messages.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return { ok: true, messages };
}

/** A file object as it appears on a Slack message (subset of fields we use). */
export interface SlackMessageFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  url_private_download?: string;
  size?: number;
  /** "external" marks remote files whose url_private is third-party-hosted. */
  mode?: string;
}

/**
 * Fetch the files attached to a single message.
 *
 * `app_mention` events don't include the message's `files` array, so when an
 * event arrives without files we recover them from conversation history. Pass
 * `threadTs` when the message is a thread reply; otherwise the top-level
 * message at `ts` is fetched. Returns the failure arm on API errors so callers
 * can distinguish "the message has no files" from "the lookup failed".
 */
export async function getMessageFiles(
  token: string,
  channelId: string,
  ts: string,
  threadTs?: string
): Promise<SlackEnvelope<{ files: SlackMessageFile[] }>> {
  // Single-message fetch. The two endpoints sort differently, so the window
  // anchor differs: conversations.history returns newest-first, so
  // `latest=<ts>&inclusive=true&limit=1` yields the target; conversations.replies
  // returns oldest-first, so the anchor must be `oldest=<ts>&inclusive=true` (a
  // `latest` anchor would yield the thread root instead). Never set oldest and
  // latest to the same ts — an equal pair is a zero-width window that Slack
  // returns empty for. `limit=2` on replies tolerates the thread root being
  // included alongside the target; the find-by-ts below is the source of truth.
  type HistoryResult = { messages?: Array<{ ts?: string; files?: SlackMessageFile[] }> };
  const res =
    threadTs && threadTs !== ts
      ? await slackGet<HistoryResult>(token, "conversations.replies", {
          channel: channelId,
          ts: threadTs,
          oldest: ts,
          inclusive: "true",
          limit: "2",
        })
      : await slackGet<HistoryResult>(token, "conversations.history", {
          channel: channelId,
          latest: ts,
          inclusive: "true",
          limit: "1",
        });
  if (!res.ok) return res;
  const message = res.messages?.find((m) => m.ts === ts);
  return { ok: true, files: message?.files ?? [] };
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
}

export function getUserInfo(
  token: string,
  userId: string
): Promise<SlackEnvelope<{ user: SlackUser }>> {
  return slackGet(token, "users.info", { user: userId });
}

export function publishView(
  token: string,
  userId: string,
  view: Record<string, unknown>
): Promise<SlackEnvelope> {
  return slackPost(token, "views.publish", { user_id: userId, view });
}

export function openView(
  token: string,
  triggerId: string,
  view: Record<string, unknown>
): Promise<SlackEnvelope> {
  return slackPost(token, "views.open", { trigger_id: triggerId, view });
}
