/**
 * Open-Inspect Slack Bot Worker
 *
 * Cloudflare Worker that handles Slack events and provides
 * a natural language interface to the coding agent.
 */

import { Hono } from "hono";
import type {
  Env,
  RepoConfig,
  CallbackContext,
  ThreadSession,
  SlackInteractionPayload,
} from "./types";
import { stripMentions, isDmDispatchable } from "./dm-utils";
import {
  verifySlackSignature,
  postMessage,
  updateMessage,
  addReaction,
  getChannelInfo,
  getThreadMessages,
  getUserInfo,
} from "@open-inspect/shared";
import { resolveUserNames } from "@open-inspect/shared";
import { createClassifier } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { callbacksRouter } from "./callbacks";
import { buildInternalAuthHeaders } from "@open-inspect/shared";
import { createLogger } from "./logger";
import { createKvCacheStore } from "@open-inspect/shared";
import { getUserRepoBranchPreference } from "./branch-preferences";
import { setAssistantThreadStatusBestEffort } from "./activity-status";
import { handleAppHomeInteractionRoute, publishAppHome } from "./app-home";
import {
  SELECT_REPO_ACTION_ID,
  SELECT_REPO_QUICK_PICK_ACTION_ID,
  getRepoClarificationOptions,
  buildRepoClarificationBlocks,
} from "./repo-clarification";
import { getResolvedUserPreferences } from "./user-preferences";
import { slackInteractionPayloadSchema } from "./interaction-payload";

const log = createLogger("handler");

type BackgroundTaskScheduler = (promise: Promise<void>) => void;

/**
 * Build authenticated headers for control plane requests.
 */
async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  return {
    "Content-Type": "application/json",
    ...(await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId)),
  };
}

/**
 * Create a session via the control plane.
 */
async function createSession(
  env: Env,
  repo: RepoConfig,
  model: string,
  reasoningEffort: string | undefined,
  branch: string | undefined,
  traceId?: string,
  slackUserId?: string,
  actorDisplayName?: string,
  actorEmail?: string
): Promise<{ sessionId: string; status: string } | null> {
  const startTime = Date.now();
  const base = {
    trace_id: traceId,
    repo_owner: repo.owner,
    repo_name: repo.name,
    model,
    reasoning_effort: reasoningEffort,
    branch,
    slack_user_id: slackUserId,
  };
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoOwner: repo.owner,
        repoName: repo.name,
        model,
        reasoningEffort,
        branch,
        spawnSource: "slack-bot",
        actorUserId: slackUserId,
        actorDisplayName,
        actorEmail,
      }),
    });

    if (!response.ok) {
      log.error("control_plane.create_session", {
        ...base,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return null;
    }

    const result = (await response.json()) as { sessionId: string; status: string };
    log.info("control_plane.create_session", {
      ...base,
      outcome: "success",
      session_id: result.sessionId,
      http_status: 200,
      duration_ms: Date.now() - startTime,
    });
    return result;
  } catch (e) {
    log.error("control_plane.create_session", {
      ...base,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return null;
  }
}

/**
 * Send a prompt to a session via the control plane.
 */
async function sendPrompt(
  env: Env,
  sessionId: string,
  content: string,
  authorId: string,
  callbackContext?: CallbackContext,
  traceId?: string
): Promise<{ messageId: string } | null> {
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, source: "slack" };
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${sessionId}/prompt`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          content,
          authorId,
          source: "slack",
          callbackContext,
        }),
      }
    );

    if (!response.ok) {
      log.error("control_plane.send_prompt", {
        ...base,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return null;
    }

    const result = (await response.json()) as { messageId: string };
    log.info("control_plane.send_prompt", {
      ...base,
      outcome: "success",
      message_id: result.messageId,
      http_status: 200,
      duration_ms: Date.now() - startTime,
    });
    return result;
  } catch (e) {
    log.error("control_plane.send_prompt", {
      ...base,
      outcome: "error",
      error: e instanceof Error ? e : new Error(String(e)),
      duration_ms: Date.now() - startTime,
    });
    return null;
  }
}

/**
 * Generate a consistent KV key for thread-to-session mapping.
 */
function getThreadSessionKey(channel: string, threadTs: string): string {
  return `thread:${channel}:${threadTs}`;
}

/**
 * Look up an existing session for a thread.
 * Returns the session info if found and not expired.
 */
async function lookupThreadSession(
  env: Env,
  channel: string,
  threadTs: string
): Promise<ThreadSession | null> {
  try {
    const key = getThreadSessionKey(channel, threadTs);
    const data = await createKvCacheStore(env.SLACK_KV).get(key, "json");
    if (data && typeof data === "object") {
      return data as ThreadSession;
    }
    return null;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

/**
 * Store a session mapping for a thread.
 * TTL is 24 hours by default.
 */
async function storeThreadSession(
  env: Env,
  channel: string,
  threadTs: string,
  session: ThreadSession
): Promise<void> {
  try {
    const key = getThreadSessionKey(channel, threadTs);
    await createKvCacheStore(env.SLACK_KV).put(key, JSON.stringify(session), {
      expirationTtl: 86400, // 24 hours
    });
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/**
 * Clear a stale session mapping for a thread.
 */
async function clearThreadSession(env: Env, channel: string, threadTs: string): Promise<void> {
  try {
    const key = getThreadSessionKey(channel, threadTs);
    await createKvCacheStore(env.SLACK_KV).delete(key);
  } catch (e) {
    log.error("kv.delete", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/**
 * Build a ThreadSession object for storage.
 */
function buildThreadSession(
  sessionId: string,
  repo: RepoConfig,
  model: string,
  reasoningEffort?: string
): ThreadSession {
  return {
    sessionId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    model,
    reasoningEffort,
    createdAt: Date.now(),
  };
}

/**
 * Format thread context for inclusion in a prompt.
 * Returns a formatted string with previous messages from the thread.
 */
function formatThreadContext(previousMessages: string[]): string {
  if (previousMessages.length === 0) {
    return "";
  }

  const context = previousMessages.join("\n");
  return `Context from the Slack thread:\n---\n${context}\n---\n\n`;
}

/**
 * Format channel context for inclusion in a prompt.
 * Returns a formatted string with the channel name and optional description.
 */
function formatChannelContext(channelName: string, channelDescription?: string): string {
  let context = `Slack channel context:\n---\nChannel: #${channelName}`;
  if (channelDescription) {
    context += `\nDescription: ${channelDescription}`;
  }
  context += "\n---\n\n";
  return context;
}

function scheduleStartingStatus(
  scheduleBackground: BackgroundTaskScheduler,
  env: Env,
  channel: string,
  threadTs: string,
  traceId?: string
): void {
  scheduleBackground(
    setAssistantThreadStatusBestEffort(env, channel, threadTs, "Starting...", {
      event: "start",
      traceId,
    })
  );
}

function buildWorkingMessageBlocks(
  repoFullName: string,
  options: { reasoning?: string; sessionId?: string; webAppUrl?: string } = {}
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: options.reasoning
          ? `Working on *${repoFullName}*...\n_${options.reasoning}_`
          : `Working on *${repoFullName}*...`,
      },
    },
  ];

  if (options.sessionId && options.webAppUrl) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "View Session",
          },
          url: `${options.webAppUrl}/session/${options.sessionId}`,
          action_id: "view_session",
        },
      ],
    });
  }

  return blocks;
}

/**
 * Create a session and send the initial prompt.
 * Shared logic between handleAppMention and handleRepoSelection.
 *
 * @returns Object containing sessionId if successful, null if session creation or prompt failed
 */
async function startSessionAndSendPrompt(
  env: Env,
  repo: RepoConfig,
  channel: string,
  threadTs: string,
  messageText: string,
  userId: string,
  previousMessages?: string[],
  channelName?: string,
  channelDescription?: string,
  traceId?: string
): Promise<{ sessionId: string } | null> {
  const userPrefs = await getResolvedUserPreferences(env, userId);
  const model = userPrefs.model;
  const reasoningEffort = userPrefs.reasoningEffort;
  const globalBranch = userPrefs.branch;
  const repoBranch = await getUserRepoBranchPreference(env, userId, repo.id);
  const branch = repoBranch ?? globalBranch;

  // Best-effort user info resolution for identity linking
  let displayName: string | undefined;
  let email: string | undefined;
  try {
    const userInfo = await getUserInfo(env.SLACK_BOT_TOKEN, userId);
    if (userInfo.ok) {
      displayName =
        userInfo.user.profile?.display_name ||
        userInfo.user.real_name ||
        userInfo.user.name ||
        undefined;
      email = userInfo.user.profile?.email || undefined;
    }
  } catch {
    // Proceed with no display name / email — control plane handles missing fields
  }

  // Create session via control plane with user's preferred model, reasoning effort, and branch
  const session = await createSession(
    env,
    repo,
    model,
    reasoningEffort,
    branch,
    traceId,
    userId,
    displayName,
    email
  );

  if (!session) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't create a session. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }

  await storeThreadSession(
    env,
    channel,
    threadTs,
    buildThreadSession(session.sessionId, repo, model, reasoningEffort)
  );

  // Build callback context for follow-up notification
  const callbackContext: CallbackContext = {
    source: "slack",
    channel,
    threadTs,
    repoFullName: repo.fullName,
    model,
    reasoningEffort,
  };

  // Build prompt content with channel and thread context if available
  const channelContext = channelName ? formatChannelContext(channelName, channelDescription) : "";
  const threadContext = previousMessages ? formatThreadContext(previousMessages) : "";
  const promptContent = channelContext + threadContext + messageText;

  // Send the prompt to the session
  const promptResult = await sendPrompt(
    env,
    session.sessionId,
    promptContent,
    `slack:${userId}`,
    callbackContext,
    traceId
  );

  if (!promptResult) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Session created but failed to send prompt. Please try again.",
      { thread_ts: threadTs }
    );
    return null;
  }

  return { sessionId: session.sessionId };
}

const app = new Hono<{ Bindings: Env }>();

// Health check
app.get("/health", async (c) => {
  let repoCount = 0;

  try {
    const repos = await getAvailableRepos(c.env);
    repoCount = repos.length;
  } catch {
    // Control plane may be unavailable
  }

  return c.json({
    status: "healthy",
    service: "open-inspect-slack-bot",
    repoCount,
  });
});

// Slack Events API
app.post("/events", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const signature = c.req.header("x-slack-signature") ?? null;
  const timestamp = c.req.header("x-slack-request-timestamp") ?? null;
  const body = await c.req.text();

  // Verify request signature
  const isValid = await verifySlackSignature(
    signature,
    timestamp,
    body,
    c.env.SLACK_SIGNING_SECRET
  );

  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/events",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(body);

  // Handle URL verification challenge
  if (payload.type === "url_verification") {
    return c.json({ challenge: payload.challenge });
  }

  // Deduplicate events - Slack can retry on timeouts
  // Use event_id to prevent duplicate session creation
  const eventId = payload.event_id as string | undefined;
  if (eventId) {
    const dedupeKey = `event:${eventId}`;
    const cacheStore = createKvCacheStore(c.env.SLACK_KV);
    const existing = await cacheStore.get(dedupeKey);
    if (existing) {
      log.debug("slack.event.duplicate", { trace_id: traceId, event_id: eventId });
      return c.json({ ok: true });
    }
    // Mark as seen with 1 hour TTL (Slack retries are within minutes)
    await cacheStore.put(dedupeKey, "1", { expirationTtl: 3600 });
  }

  const scheduleBackground = (promise: Promise<void>) => c.executionCtx.waitUntil(promise);
  const eventTask = Promise.resolve().then(() =>
    handleSlackEvent(payload, c.env, traceId, scheduleBackground)
  );

  // Process event asynchronously
  c.executionCtx.waitUntil(eventTask);

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/events",
    http_status: 200,
    event_id: eventId,
    event_type: payload.event?.type,
    duration_ms: Date.now() - startTime,
  });

  // Respond immediately (Slack requires response within 3 seconds)
  return c.json({ ok: true });
});

// Slack Interactions (buttons, modals, etc.)
app.post("/interactions", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();
  const signature = c.req.header("x-slack-signature") ?? null;
  const timestamp = c.req.header("x-slack-request-timestamp") ?? null;
  const body = await c.req.text();

  const isValid = await verifySlackSignature(
    signature,
    timestamp,
    body,
    c.env.SLACK_SIGNING_SECRET
  );

  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Invalid signature" }, 401);
  }

  const payloadStr = new URLSearchParams(body).get("payload") || "{}";
  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(payloadStr);
  } catch {
    return c.json({ error: "Invalid payload" }, 400);
  }

  const parsedPayload = slackInteractionPayloadSchema.safeParse(rawPayload);
  if (!parsedPayload.success) {
    return c.json({ error: "Invalid payload" }, 400);
  }
  const payload: SlackInteractionPayload = parsedPayload.data;
  const scheduleBackground = (promise: Promise<void>) => c.executionCtx.waitUntil(promise);

  const appHomeResponse = await handleAppHomeInteractionRoute(
    payload,
    c.env,
    traceId,
    scheduleBackground
  );
  if (appHomeResponse) {
    log.info("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 200,
      ...appHomeResponse.logContext,
      duration_ms: Date.now() - startTime,
    });
    return c.json(appHomeResponse.body);
  }

  if (payload.type === "block_suggestion") {
    const options =
      payload.action_id === SELECT_REPO_ACTION_ID
        ? await getRepoClarificationOptions(c.env, payload.value, traceId).catch((e) => {
            // A repo-lookup failure must not surface as a 500 on /interactions —
            // return no matches instead.
            log.error("slack.repo_clarification_options", {
              trace_id: traceId,
              query: payload.value,
              error: e instanceof Error ? e : new Error(String(e)),
              duration_ms: Date.now() - startTime,
            });
            return [];
          })
        : [];
    log.info("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 200,
      interaction_type: payload.type,
      action_id: payload.action_id,
      option_count: options.length,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ options });
  }

  const actionId = payload.actions?.[0]?.action_id ?? payload.action_id;
  const interactionTask = Promise.resolve().then(() =>
    handleSlackInteraction(payload, c.env, traceId, scheduleBackground)
  );
  c.executionCtx.waitUntil(interactionTask);

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/interactions",
    http_status: 200,
    interaction_type: payload.type,
    action_id: actionId,
    callback_id: payload.view?.callback_id,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
});

// Mount callbacks router for control-plane notifications
app.route("/callbacks", callbacksRouter);

/**
 * Handle incoming Slack events.
 */
async function handleSlackEvent(
  payload: {
    type: string;
    event?: {
      type: string;
      text?: string;
      user?: string;
      channel?: string;
      ts?: string;
      thread_ts?: string;
      bot_id?: string;
      tab?: string;
      channel_type?: string; // "im" for direct messages, "channel" for public channels, etc.
      subtype?: string; // e.g. "bot_message", "message_changed", etc.
      attachments?: Array<{
        text?: string;
        pretext?: string;
        author_name?: string;
        from_url?: string;
        channel_name?: string;
        footer?: string;
      }>;
    };
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  if (payload.type !== "event_callback" || !payload.event) {
    return;
  }

  const event = payload.event;

  // Ignore bot messages to prevent loops
  if (event.bot_id) {
    return;
  }

  // Handle app_home_opened events
  if (event.type === "app_home_opened" && event.tab === "home" && event.user) {
    await publishAppHome(env, event.user);
    return;
  }

  // Handle direct messages (DMs) to the bot
  if (isDmDispatchable(event)) {
    await handleDirectMessage(
      {
        type: event.type,
        text: event.text!,
        user: event.user!,
        channel: event.channel!,
        ts: event.ts!,
        thread_ts: event.thread_ts,
        channel_type: event.channel_type,
      },
      env,
      traceId,
      scheduleBackground
    );
    return;
  }

  // Handle app_mention events
  if (event.type === "app_mention" && event.text && event.channel && event.ts) {
    await handleAppMention(event as Required<typeof event>, env, traceId, scheduleBackground);
  }
}

/**
 * Parameters for the shared incoming message handler.
 */
interface IncomingMessageParams {
  text: string; // Already cleaned message text
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  channelName?: string;
  channelDescription?: string;
  env: Env;
  traceId?: string;
  scheduleBackground: BackgroundTaskScheduler;
}

/**
 * Shared logic for handling incoming messages (both @mentions and DMs).
 *
 * Handles:
 * - Thread context fetch
 * - Existing session lookup + prompt
 * - Repo classification
 * - Clarification / repo selection UI
 * - Ack message + session creation
 */
async function handleIncomingMessage(params: IncomingMessageParams): Promise<void> {
  const {
    text: messageText,
    user,
    channel,
    ts,
    threadTs,
    channelName,
    channelDescription,
    env,
    traceId,
    scheduleBackground,
  } = params;

  if (!messageText) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Hi! Please include a message with your request.",
      { thread_ts: threadTs || ts }
    );
    return;
  }

  // Get thread context if in a thread (include bot messages for better context)
  // Fetched early so it's available for both existing session prompts and new sessions
  let previousMessages: string[] | undefined;
  if (threadTs) {
    try {
      const threadResult = await getThreadMessages(env.SLACK_BOT_TOKEN, channel, threadTs, 10);
      if (threadResult.ok && threadResult.messages) {
        const filtered = threadResult.messages.filter((m) => m.ts !== ts);
        // Resolve unique user IDs to display names for attribution
        const uniqueUserIds = [...new Set(filtered.map((m) => m.user).filter(Boolean))] as string[];
        const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, uniqueUserIds);
        previousMessages = filtered
          .map((m) => {
            if (m.bot_id) return `[Bot]: ${m.text}`;
            const name = m.user ? userNames.get(m.user) || m.user : "Unknown";
            return `[${name}]: ${m.text}`;
          })
          .slice(-10);
      }
    } catch {
      // Thread messages not available
    }
  }

  // Check for existing session in this thread
  if (threadTs) {
    const existingSession = await lookupThreadSession(env, channel, threadTs);
    if (existingSession) {
      const callbackContext: CallbackContext = {
        source: "slack",
        channel,
        threadTs,
        repoFullName: existingSession.repoFullName,
        model: existingSession.model,
        reasoningEffort: existingSession.reasoningEffort,
        reactionMessageTs: ts,
      };

      const channelContext = channelName
        ? formatChannelContext(channelName, channelDescription)
        : "";
      // Existing sessions already have prior turns; adding Slack bot replies again can echo stale answers.
      const promptContent = channelContext + messageText;

      const promptResult = await sendPrompt(
        env,
        existingSession.sessionId,
        promptContent,
        `slack:${user}`,
        callbackContext,
        traceId
      );

      if (promptResult) {
        const reactionResult = await addReaction(env.SLACK_BOT_TOKEN, channel, ts, "eyes");
        if (!reactionResult.ok && reactionResult.error !== "already_reacted") {
          log.warn("slack.reaction.add", {
            trace_id: traceId,
            channel,
            message_ts: ts,
            reaction: "eyes",
            slack_error: reactionResult.error,
          });
        }
        return;
      }

      log.warn("thread_session.stale", {
        trace_id: traceId,
        session_id: existingSession.sessionId,
        channel,
        thread_ts: threadTs,
      });
      await clearThreadSession(env, channel, threadTs);
    }
  }

  // Classify the repository
  const classifier = createClassifier(env);
  const result = await classifier.classify(
    messageText,
    {
      channelId: channel,
      channelName,
      channelDescription,
      threadTs,
      previousMessages,
    },
    traceId
  );

  // Post initial response
  if (result.needsClarification || !result.repo) {
    // Need to clarify which repo
    const repos = await getAvailableRepos(env, traceId);

    if (repos.length === 0) {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Sorry, no repositories are currently available. Please check that the GitHub App is installed and configured.",
        { thread_ts: threadTs || ts }
      );
      return;
    }

    // Store original message in KV for later retrieval when user selects a repo
    const pendingKey = `pending:${channel}:${threadTs || ts}`;
    await createKvCacheStore(env.SLACK_KV).put(
      pendingKey,
      JSON.stringify({
        message: messageText,
        userId: user,
        previousMessages,
        channelName,
        channelDescription,
      }),
      { expirationTtl: 3600 } // Expire after 1 hour
    );

    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      `I couldn't determine which repository you're referring to. ${result.reasoning}`,
      {
        thread_ts: threadTs || ts,
        blocks: buildRepoClarificationBlocks(result.reasoning, result.alternatives),
      }
    );
    return;
  }

  // We have a confident repo match - acknowledge and start session
  const { repo } = result;
  const threadKey = threadTs || ts;

  // Post initial acknowledgment
  const ackResult = await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    `Working on *${repo.fullName}*...`,
    {
      thread_ts: threadKey,
      blocks: buildWorkingMessageBlocks(repo.fullName, { reasoning: result.reasoning }),
    }
  );

  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);

  // Create session and send prompt using shared logic
  const sessionResult = await startSessionAndSendPrompt(
    env,
    repo,
    channel,
    threadKey,
    messageText,
    user,
    previousMessages,
    channelName,
    channelDescription,
    traceId
  );

  if (!sessionResult) {
    return;
  }

  // Update the acknowledgment message with session link button
  if (ackTs) {
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, `Working on *${repo.fullName}*...`, {
      blocks: buildWorkingMessageBlocks(repo.fullName, {
        reasoning: result.reasoning,
        sessionId: sessionResult.sessionId,
        webAppUrl: env.WEB_APP_URL,
      }),
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}

/**
 * Handle app_mention events.
 */
async function handleAppMention(
  event: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  // Remove the bot mention from the text
  const messageText = stripMentions(event.text);
  const threadKey = event.thread_ts || event.ts;

  if (messageText) {
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  }

  // Get channel context
  let channelName: string | undefined;
  let channelDescription: string | undefined;

  if (messageText) {
    try {
      const channelInfo = await getChannelInfo(env.SLACK_BOT_TOKEN, event.channel);
      if (channelInfo.ok && channelInfo.channel) {
        channelName = channelInfo.channel.name;
        channelDescription = channelInfo.channel.topic?.value || channelInfo.channel.purpose?.value;
      }
    } catch {
      // Channel info not available
    }
  }

  await handleIncomingMessage({
    text: messageText,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    channelName,
    channelDescription,
    env,
    traceId,
    scheduleBackground,
  });
}

/**
 * Handle direct messages (DMs) to the bot.
 * Users don't need to @mention the bot in DMs.
 */
async function handleDirectMessage(
  event: {
    type: string;
    text: string;
    user: string;
    channel: string;
    ts: string;
    thread_ts?: string;
    channel_type?: string;
  },
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  log.info("slack.dm.received", { trace_id: traceId, user: event.user, channel: event.channel });

  // Strip any @mentions (users may type "@Bot <request>" in DMs)
  const messageText = stripMentions(event.text);
  const threadKey = event.thread_ts || event.ts;

  if (messageText) {
    scheduleStartingStatus(scheduleBackground, env, event.channel, threadKey, traceId);
  }

  await handleIncomingMessage({
    text: messageText,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    env,
    traceId,
    scheduleBackground,
  });
}

/**
 * Handle repo selection from clarification dropdown.
 */
async function handleRepoSelection(
  repoId: string,
  channel: string,
  messageTs: string,
  threadTs: string | undefined,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  // Retrieve pending message from KV
  const pendingKey = `pending:${channel}:${threadTs || messageTs}`;
  const pendingData = await createKvCacheStore(env.SLACK_KV).get(pendingKey, "json");

  if (!pendingData || typeof pendingData !== "object") {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't find your original request. Please try again.",
      { thread_ts: threadTs || messageTs }
    );
    return;
  }

  const {
    message: messageText,
    userId,
    previousMessages,
    channelName,
    channelDescription,
  } = pendingData as {
    message: string;
    userId: string;
    previousMessages?: string[];
    channelName?: string;
    channelDescription?: string;
  };

  const threadKey = threadTs || messageTs;

  // Find the repo config
  const repos = await getAvailableRepos(env, traceId);
  const repo = repos.find((r) => r.id === repoId);

  if (!repo) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, that repository is no longer available. Please try again.",
      { thread_ts: threadTs || messageTs }
    );
    return;
  }

  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);

  // Post acknowledgment
  const ackResult = await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    `Working on *${repo.fullName}*...`,
    {
      thread_ts: threadKey,
      blocks: buildWorkingMessageBlocks(repo.fullName),
    }
  );
  const ackTs = ackResult.ok ? ackResult.ts : undefined;
  scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);

  // Create session and send prompt using shared logic
  const sessionResult = await startSessionAndSendPrompt(
    env,
    repo,
    channel,
    threadKey,
    messageText,
    userId,
    previousMessages,
    channelName,
    channelDescription,
    traceId
  );

  if (!sessionResult) {
    return;
  }

  // Clean up pending message
  await createKvCacheStore(env.SLACK_KV).delete(pendingKey);

  if (ackTs) {
    await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, `Working on *${repo.fullName}*...`, {
      blocks: buildWorkingMessageBlocks(repo.fullName, {
        sessionId: sessionResult.sessionId,
        webAppUrl: env.WEB_APP_URL,
      }),
    });
    scheduleStartingStatus(scheduleBackground, env, channel, threadKey, traceId);
  }
}

/**
 * Handle Slack interactions (buttons, select menus, etc.)
 */
async function handleSlackInteraction(
  payload: SlackInteractionPayload,
  env: Env,
  traceId: string | undefined,
  scheduleBackground: BackgroundTaskScheduler
): Promise<void> {
  if (payload.type !== "block_actions" || !payload.actions?.length) {
    return;
  }

  const action = payload.actions[0];
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts;

  switch (action.action_id) {
    case SELECT_REPO_ACTION_ID:
    case SELECT_REPO_QUICK_PICK_ACTION_ID: {
      if (!channel || !messageTs) return;
      // external_select selection carries selected_option; quick-pick buttons carry value.
      const repoId = action.selected_option?.value ?? action.value;
      if (repoId) {
        await handleRepoSelection(
          repoId,
          channel,
          messageTs,
          threadTs,
          env,
          traceId,
          scheduleBackground
        );
      }
      break;
    }

    case "view_session": {
      // This is a URL button, no action needed
      break;
    }
  }
}

export default app;
