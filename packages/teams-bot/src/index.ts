/**
 * Open-Inspect Teams Bot Worker
 *
 * Cloudflare Worker that handles Microsoft Teams Bot Framework activities
 * and provides a natural language interface to the coding agent.
 */

import { Hono } from "hono";
import type { Env, RepoConfig, Activity, ThreadSession, UserPreferences } from "./types";
import type { TeamsCallbackContext, CallbackContext } from "@open-inspect/shared";
import { validateBotFrameworkToken } from "./utils/jwt-validator";
import { sendReply } from "./utils/teams-client";
import { createClassifier } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { callbacksRouter } from "./callbacks";
import { generateInternalToken } from "./utils/internal";
import { createLogger } from "./logger";
import { buildRepoSelectionCard } from "./adaptive-cards/repo-selection";
import { buildModelSelectionCard } from "./adaptive-cards/model-selection";
import {
  MODEL_OPTIONS,
  DEFAULT_MODEL,
  DEFAULT_ENABLED_MODELS,
  isValidModel,
  getValidModelOrDefault,
  getReasoningConfig,
  getDefaultReasoningEffort,
  isValidReasoningEffort,
} from "@open-inspect/shared";

const log = createLogger("handler");

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getAuthHeaders(env: Env, traceId?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.INTERNAL_CALLBACK_SECRET) {
    const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  if (traceId) {
    headers["x-trace-id"] = traceId;
  }
  return headers;
}

async function createSession(
  env: Env,
  repo: RepoConfig,
  title: string | undefined,
  model: string,
  reasoningEffort: string | undefined,
  traceId?: string
): Promise<{ sessionId: string; status: string } | null> {
  const startTime = Date.now();
  const base = {
    trace_id: traceId,
    repo_owner: repo.owner,
    repo_name: repo.name,
    model,
    reasoning_effort: reasoningEffort,
  };
  try {
    const headers = await getAuthHeaders(env, traceId);
    const requestBody = {
      repoOwner: repo.owner,
      repoName: repo.name,
      title: title || `Teams: ${repo.name}`,
      model,
      reasoningEffort,
    };
    const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let responseBody = "";
      try {
        responseBody = await response.text();
      } catch {
        // Ignore if body can't be read
      }
      log.error("control_plane.create_session", {
        ...base,
        outcome: "error",
        http_status: response.status,
        response_body: responseBody,
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

async function isSessionActive(env: Env, sessionId: string, traceId?: string): Promise<boolean> {
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch(`https://internal/sessions/${sessionId}`, {
      headers,
    });
    if (!response.ok) return false;
    const data = (await response.json()) as { status?: string };
    return data.status !== "archived";
  } catch {
    return false;
  }
}

async function sendPrompt(
  env: Env,
  sessionId: string,
  content: string,
  authorId: string,
  callbackContext?: CallbackContext,
  traceId?: string
): Promise<{ messageId: string } | null> {
  const startTime = Date.now();
  const base = { trace_id: traceId, session_id: sessionId, source: "teams" };
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
          source: "teams",
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

// ─── KV Thread Session Mapping ────────────────────────────────────────────────

function getThreadSessionKey(conversationId: string, rootActivityId: string): string {
  return `thread:${conversationId}:${rootActivityId}`;
}

function isDirectMessage(activity: Activity): boolean {
  return activity.conversation.conversationType === "personal";
}

async function lookupThreadSession(
  env: Env,
  conversationId: string,
  rootActivityId: string
): Promise<ThreadSession | null> {
  try {
    const key = getThreadSessionKey(conversationId, rootActivityId);
    const data = await env.TEAMS_KV.get(key, "json");
    if (data && typeof data === "object") {
      return data as ThreadSession;
    }
    return null;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "thread",
      conversation_id: conversationId,
      root_activity_id: rootActivityId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

async function storeThreadSession(
  env: Env,
  conversationId: string,
  rootActivityId: string,
  session: ThreadSession
): Promise<void> {
  try {
    const key = getThreadSessionKey(conversationId, rootActivityId);
    await env.TEAMS_KV.put(key, JSON.stringify(session), {
      expirationTtl: 86400, // 24 hours
    });
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "thread",
      conversation_id: conversationId,
      root_activity_id: rootActivityId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

async function clearThreadSession(
  env: Env,
  conversationId: string,
  rootActivityId: string
): Promise<void> {
  try {
    const key = getThreadSessionKey(conversationId, rootActivityId);
    await env.TEAMS_KV.delete(key);
  } catch (e) {
    log.error("kv.delete", {
      key_prefix: "thread",
      conversation_id: conversationId,
      root_activity_id: rootActivityId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

// ─── KV User Preferences ─────────────────────────────────────────────────────

function getUserPreferencesKey(userId: string): string {
  return `user_prefs:${userId}`;
}

function isValidUserPreferences(data: unknown): data is UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.userId === "string" &&
    typeof obj.model === "string" &&
    typeof obj.updatedAt === "number"
  );
}

async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  try {
    const key = getUserPreferencesKey(userId);
    const data = await env.TEAMS_KV.get(key, "json");
    if (isValidUserPreferences(data)) return data;
    return null;
  } catch (e) {
    log.error("kv.get", {
      key_prefix: "user_prefs",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

async function saveUserPreferences(
  env: Env,
  userId: string,
  model: string,
  reasoningEffort?: string
): Promise<boolean> {
  try {
    const key = getUserPreferencesKey(userId);
    const prefs: UserPreferences = {
      userId,
      model,
      reasoningEffort,
      updatedAt: Date.now(),
    };
    await env.TEAMS_KV.put(key, JSON.stringify(prefs));
    return true;
  } catch (e) {
    log.error("kv.put", {
      key_prefix: "user_prefs",
      user_id: userId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return false;
  }
}

// ─── Model Resolution ─────────────────────────────────────────────────────────

const ALL_MODELS = MODEL_OPTIONS.flatMap((group) =>
  group.models.map((m) => ({
    label: `${m.name} (${m.description})`,
    value: m.id,
  }))
);

async function getAvailableModels(
  env: Env,
  traceId?: string
): Promise<{ label: string; value: string }[]> {
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/model-preferences", {
      method: "GET",
      headers,
    });

    if (response.ok) {
      const data = (await response.json()) as { enabledModels: string[] };
      if (data.enabledModels.length > 0) {
        const enabledSet = new Set(data.enabledModels);
        return ALL_MODELS.filter((m) => enabledSet.has(m.value));
      }
    }
  } catch {
    // Fall through to defaults
  }

  const defaultSet = new Set<string>(DEFAULT_ENABLED_MODELS);
  return ALL_MODELS.filter((m) => defaultSet.has(m.value));
}

// ─── Activity Helpers ─────────────────────────────────────────────────────────

/**
 * Strip bot @mention markup from activity text.
 * Teams includes mention entities as <at>BotName</at> in the text.
 */
function stripBotMention(activity: Activity): string {
  let text = activity.text || "";
  if (activity.entities) {
    for (const entity of activity.entities) {
      if (entity.type === "mention" && entity.text) {
        text = text.replace(entity.text, "");
      }
    }
  }
  // Strip residual HTML tags Teams might inject
  text = text.replace(/<[^>]+>/g, "").trim();
  return text;
}

function buildThreadSession(
  sessionId: string,
  repo: RepoConfig,
  model: string,
  reasoningEffort?: string,
  typingMode?: string
): ThreadSession {
  return {
    sessionId,
    repoId: repo.id,
    repoFullName: repo.fullName,
    model,
    reasoningEffort,
    typingMode,
    createdAt: Date.now(),
  };
}

function getTeamsUserId(activity: Activity): string {
  return activity.from.aadObjectId || activity.from.id;
}

// ─── Integration Settings ─────────────────────────────────────────────────────

interface TeamsIntegrationConfig {
  model: string | null;
  reasoningEffort: string | null;
  typingMode: string | null;
}

async function getTeamsIntegrationConfig(
  env: Env,
  repoFullName: string,
  traceId?: string
): Promise<TeamsIntegrationConfig> {
  try {
    const [owner, name] = repoFullName.split("/");
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/teams/resolved/${owner}/${name}`,
      { headers }
    );

    if (!response.ok) return { model: null, reasoningEffort: null, typingMode: null };

    const data = (await response.json()) as {
      config: {
        model: string | null;
        reasoningEffort: string | null;
        typingMode: string | null;
      } | null;
    };

    return {
      model: data.config?.model ?? null,
      reasoningEffort: data.config?.reasoningEffort ?? null,
      typingMode: data.config?.typingMode ?? null,
    };
  } catch {
    return { model: null, reasoningEffort: null, typingMode: null };
  }
}

// ─── Session Lifecycle ────────────────────────────────────────────────────────

async function startSessionAndSendPrompt(
  env: Env,
  repo: RepoConfig,
  activity: Activity,
  sessionKey: string,
  replyActivityId: string,
  messageText: string,
  traceId?: string
): Promise<{ sessionId: string } | null> {
  const userId = getTeamsUserId(activity);
  const conversationId = activity.conversation.id;

  // Model priority: user prefs > integration settings > DEFAULT_MODEL
  const userPrefs = await getUserPreferences(env, userId);
  const integrationConfig = await getTeamsIntegrationConfig(env, repo.fullName, traceId);

  const fallback = integrationConfig.model || env.DEFAULT_MODEL || DEFAULT_MODEL;
  const model = getValidModelOrDefault(userPrefs?.model ?? fallback);
  const reasoningEffort =
    userPrefs?.reasoningEffort && isValidReasoningEffort(model, userPrefs.reasoningEffort)
      ? userPrefs.reasoningEffort
      : integrationConfig.reasoningEffort &&
          isValidReasoningEffort(model, integrationConfig.reasoningEffort)
        ? integrationConfig.reasoningEffort
        : getDefaultReasoningEffort(model);

  const session = await createSession(
    env,
    repo,
    messageText.slice(0, 100),
    model,
    reasoningEffort,
    traceId
  );

  if (!session) {
    await sendReply(
      activity.serviceUrl,
      conversationId,
      replyActivityId,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      "Sorry, I couldn't create a session. Please try again."
    );
    return null;
  }

  await storeThreadSession(
    env,
    conversationId,
    sessionKey,
    buildThreadSession(
      session.sessionId,
      repo,
      model,
      reasoningEffort,
      integrationConfig.typingMode ?? undefined
    )
  );

  const callbackContext: TeamsCallbackContext = {
    source: "teams",
    conversationId,
    activityId: replyActivityId,
    serviceUrl: activity.serviceUrl,
    repoFullName: repo.fullName,
    model,
    reasoningEffort,
    typingMode: integrationConfig.typingMode ?? undefined,
    tenantId: activity.conversation.tenantId,
  };

  const promptResult = await sendPrompt(
    env,
    session.sessionId,
    messageText,
    `teams:${userId}`,
    callbackContext,
    traceId
  );

  if (!promptResult) {
    await sendReply(
      activity.serviceUrl,
      conversationId,
      replyActivityId,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      "Session created but failed to send prompt. Please try again."
    );
    return null;
  }

  return { sessionId: session.sessionId };
}

// ─── Message Handling ─────────────────────────────────────────────────────────

async function handleMessage(activity: Activity, env: Env, traceId: string): Promise<void> {
  // Adaptive Card Action.Submit sends a message (not invoke) with data in activity.value.
  // If activity.value is set at all, treat it as a card submission — do NOT fall through
  // to the empty-text check, which would respond with "Please include a message".
  if (activity.value && typeof activity.value === "object") {
    await handleInvoke(activity, env, traceId);
    return;
  }

  const messageText = stripBotMention(activity);
  const conversationId = activity.conversation.id;
  const replyActivityId = activity.replyToId || activity.id;

  if (!messageText) {
    // Empty messages are often card submission echoes from Teams (it sends both an
    // invoke with the card data AND a separate empty message). Don't respond to avoid loops.
    log.debug("message.empty_text", {
      trace_id: traceId,
      activity_id: activity.id,
      reply_to_id: activity.replyToId,
      conversation_type: activity.conversation.conversationType,
    });
    return;
  }

  // Handle settings command
  if (messageText.toLowerCase() === "settings" || messageText.toLowerCase() === "preferences") {
    await handleSettingsCommand(activity, env, traceId);
    return;
  }

  // Handle reset command — clear the current DM/thread session
  if (
    messageText.toLowerCase() === "reset" ||
    messageText.toLowerCase() === "new" ||
    messageText.toLowerCase() === "new session"
  ) {
    const isDmReset = isDirectMessage(activity);
    const resetKey = isDmReset ? "dm" : activity.replyToId || activity.id;
    await clearThreadSession(env, conversationId, resetKey);
    await sendReply(
      activity.serviceUrl,
      conversationId,
      activity.replyToId || activity.id,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      "Session cleared. Send a new message to start a fresh session."
    );
    return;
  }

  // Session key for KV: DMs use a fixed "dm" sentinel, channels use the thread root activity ID.
  // Reply target: always a real activity ID for Bot Framework API calls.
  const isDm = isDirectMessage(activity);
  const sessionKey = isDm ? "dm" : activity.replyToId || activity.id;

  // Check for existing thread session (always check in DMs)
  if (isDm || activity.replyToId) {
    const existingSession = await lookupThreadSession(env, conversationId, sessionKey);
    if (existingSession) {
      // Check if session is still active (not archived)
      const active = await isSessionActive(env, existingSession.sessionId, traceId);
      if (!active) {
        log.info("thread_session.archived", {
          trace_id: traceId,
          session_id: existingSession.sessionId,
          conversation_id: conversationId,
          session_key: sessionKey,
        });
        await clearThreadSession(env, conversationId, sessionKey);
        // Fall through to create a new session
      } else {
        const callbackContext: TeamsCallbackContext = {
          source: "teams",
          conversationId,
          activityId: replyActivityId,
          serviceUrl: activity.serviceUrl,
          repoFullName: existingSession.repoFullName,
          model: existingSession.model,
          reasoningEffort: existingSession.reasoningEffort,
          typingMode: existingSession.typingMode,
          tenantId: activity.conversation.tenantId,
        };

        const promptResult = await sendPrompt(
          env,
          existingSession.sessionId,
          messageText,
          `teams:${getTeamsUserId(activity)}`,
          callbackContext,
          traceId
        );

        if (promptResult) {
          return;
        }

        log.warn("thread_session.stale", {
          trace_id: traceId,
          session_id: existingSession.sessionId,
          conversation_id: conversationId,
          session_key: sessionKey,
        });
        await clearThreadSession(env, conversationId, sessionKey);
      }
    }
  }

  // Classify repo
  const classifier = createClassifier(env);
  const result = await classifier.classify(
    messageText,
    {
      channelId: conversationId,
      channelName: activity.channelData?.channel?.name,
    },
    traceId
  );

  if (result.needsClarification || !result.repo) {
    const repos = await getAvailableRepos(env, traceId);

    if (repos.length === 0) {
      await sendReply(
        activity.serviceUrl,
        conversationId,
        replyActivityId,
        env.MICROSOFT_APP_ID,
        env.MICROSOFT_APP_PASSWORD,
        env.MICROSOFT_TENANT_ID,
        "Sorry, no repositories are currently available. Please check that the GitHub App is installed and configured."
      );
      return;
    }

    // Store pending message for later retrieval (keyed by sessionKey for consistency)
    const pendingKey = `pending:${conversationId}:${sessionKey}`;
    await env.TEAMS_KV.put(
      pendingKey,
      JSON.stringify({
        message: messageText,
        userId: getTeamsUserId(activity),
        serviceUrl: activity.serviceUrl,
        tenantId: activity.conversation.tenantId,
      }),
      { expirationTtl: 3600 }
    );

    const selectRepos = (result.alternatives || repos.slice(0, 5)).map((r) => ({
      id: r.id,
      displayName: r.displayName,
      description: r.description,
    }));

    const card = buildRepoSelectionCard(selectRepos, result.reasoning);

    await sendReply(
      activity.serviceUrl,
      conversationId,
      replyActivityId,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      "Which repository should I work with?",
      [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }]
    );
    return;
  }

  // Confident match — start session
  const { repo } = result;

  const sessionResult = await startSessionAndSendPrompt(
    env,
    repo,
    activity,
    sessionKey,
    replyActivityId,
    messageText,
    traceId
  );

  if (!sessionResult) return;

  const sessionUrl = `${env.WEB_APP_URL}/session/${sessionResult.sessionId}`;
  await sendReply(
    activity.serviceUrl,
    conversationId,
    replyActivityId,
    env.MICROSOFT_APP_ID,
    env.MICROSOFT_APP_PASSWORD,
    env.MICROSOFT_TENANT_ID,
    `Working on **${repo.fullName}**... [View Session](${sessionUrl})`
  );
}

// ─── Settings Command ─────────────────────────────────────────────────────────

async function handleSettingsCommand(activity: Activity, env: Env, traceId: string): Promise<void> {
  const userId = getTeamsUserId(activity);
  const prefs = await getUserPreferences(env, userId);
  const fallback = env.DEFAULT_MODEL || DEFAULT_MODEL;
  const currentModel = getValidModelOrDefault(prefs?.model ?? fallback);
  const availableModels = await getAvailableModels(env, traceId);

  const reasoningConfig = getReasoningConfig(currentModel);
  const currentEffort =
    prefs?.reasoningEffort && isValidReasoningEffort(currentModel, prefs.reasoningEffort)
      ? prefs.reasoningEffort
      : getDefaultReasoningEffort(currentModel);

  const card = buildModelSelectionCard(
    currentModel,
    currentEffort,
    availableModels,
    reasoningConfig?.efforts
  );

  await sendReply(
    activity.serviceUrl,
    activity.conversation.id,
    activity.id,
    env.MICROSOFT_APP_ID,
    env.MICROSOFT_APP_PASSWORD,
    env.MICROSOFT_TENANT_ID,
    "Open-Inspect Settings",
    [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }]
  );
}

// ─── Invoke Handling (Adaptive Card Submissions) ──────────────────────────────

async function handleInvoke(activity: Activity, env: Env, traceId: string): Promise<void> {
  try {
    await handleInvokeInner(activity, env, traceId);
  } catch (error) {
    log.error("invoke.unhandled_error", {
      trace_id: traceId,
      activity_id: activity.id,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    // Surface the error to the user instead of silent failure
    try {
      await sendReply(
        activity.serviceUrl,
        activity.conversation.id,
        activity.replyToId || activity.id,
        env.MICROSOFT_APP_ID,
        env.MICROSOFT_APP_PASSWORD,
        env.MICROSOFT_TENANT_ID,
        "Something went wrong processing your selection. Please try again."
      );
    } catch {
      // Best-effort — if this also fails, there's nothing more we can do
    }
  }
}

async function handleInvokeInner(activity: Activity, env: Env, traceId: string): Promise<void> {
  const value = activity.value as Record<string, unknown> | undefined;
  if (!value) return;

  // Extract action and input data from multiple possible structures:
  // 1. Flat (Action.Submit message): { action: "select_repo", repoId: "..." }
  // 2. Nested data: { data: { action: "select_repo" }, repoId: "..." }
  // 3. Teams invoke (adaptiveCard/action): { action: { type: "Action.Submit", data: { action: "select_repo" } }, trigger: "manual" }
  let action: unknown = value.action;
  let inputs = value; // By default, input fields are at top level

  if (action && typeof action === "object") {
    // Teams invoke wraps action as an object — extract from action.data
    const actionObj = action as Record<string, unknown>;
    const actionData = actionObj.data as Record<string, unknown> | undefined;
    action = actionData?.action ?? actionObj.verb;
    // Input fields may be inside action.data
    if (actionData) {
      inputs = { ...value, ...actionData };
    }
  }

  if (!action && value.data && typeof value.data === "object") {
    const data = value.data as Record<string, unknown>;
    action = data.action;
    inputs = { ...value, ...data };
  }

  if (!action) {
    log.warn("invoke.unknown_value", {
      trace_id: traceId,
      value_keys: Object.keys(value),
      value_action_type: typeof value.action,
    });
    return;
  }

  switch (action) {
    case "select_repo": {
      const repoId = (inputs.repoId as string) || "";
      if (repoId) {
        await handleRepoSelection(repoId, activity, env, traceId);
      } else {
        log.warn("invoke.empty_repo_id", {
          trace_id: traceId,
          input_keys: Object.keys(inputs),
          value_keys: Object.keys(value),
        });
        await sendReply(
          activity.serviceUrl,
          activity.conversation.id,
          activity.replyToId || activity.id,
          env.MICROSOFT_APP_ID,
          env.MICROSOFT_APP_PASSWORD,
          env.MICROSOFT_TENANT_ID,
          "Please select a repository from the dropdown first."
        );
      }
      break;
    }
    case "save_preferences": {
      const model = inputs.model as string;
      const reasoningEffort = inputs.reasoningEffort as string | undefined;
      const userId = getTeamsUserId(activity);

      if (model && isValidModel(model)) {
        const effort =
          reasoningEffort && isValidReasoningEffort(model, reasoningEffort)
            ? reasoningEffort
            : getDefaultReasoningEffort(model);

        await saveUserPreferences(env, userId, model, effort);

        await sendReply(
          activity.serviceUrl,
          activity.conversation.id,
          activity.id,
          env.MICROSOFT_APP_ID,
          env.MICROSOFT_APP_PASSWORD,
          env.MICROSOFT_TENANT_ID,
          `Preferences saved! Model: ${model}${effort ? `, Effort: ${effort}` : ""}`
        );
      }
      break;
    }
  }
}

async function handleRepoSelection(
  repoId: string,
  activity: Activity,
  env: Env,
  traceId: string
): Promise<void> {
  const conversationId = activity.conversation.id;
  const sessionKey = isDirectMessage(activity) ? "dm" : activity.replyToId || activity.id;
  const replyActivityId = activity.replyToId || activity.id;

  // Retrieve pending message from KV — try primary key, then DM fallback.
  // Card submission activities may not carry conversationType, so isDirectMessage
  // can return false even for DMs. Fall back to the "dm" key in that case.
  let resolvedSessionKey = sessionKey;
  let pendingKey = `pending:${conversationId}:${sessionKey}`;
  let pendingData = await env.TEAMS_KV.get(pendingKey, "json");

  if ((!pendingData || typeof pendingData !== "object") && sessionKey !== "dm") {
    const dmPendingKey = `pending:${conversationId}:dm`;
    pendingData = await env.TEAMS_KV.get(dmPendingKey, "json");
    if (pendingData && typeof pendingData === "object") {
      pendingKey = dmPendingKey;
      resolvedSessionKey = "dm"; // Store session under DM key for future lookups
    }
  }

  if (!pendingData || typeof pendingData !== "object") {
    log.warn("repo_selection.pending_not_found", {
      trace_id: traceId,
      conversation_id: conversationId,
      session_key: sessionKey,
      repo_id: repoId,
      conversation_type: activity.conversation.conversationType,
    });
    await sendReply(
      activity.serviceUrl,
      conversationId,
      replyActivityId,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      "Sorry, I couldn't find your original request. Please send your message again."
    );
    return;
  }

  const {
    message: messageText,
    serviceUrl,
    tenantId,
  } = pendingData as {
    message: string;
    userId: string;
    serviceUrl: string;
    tenantId?: string;
  };

  const repos = await getAvailableRepos(env, traceId);
  const repo = repos.find((r) => r.id === repoId);

  if (!repo) {
    await sendReply(
      activity.serviceUrl,
      conversationId,
      replyActivityId,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      "Sorry, that repository is no longer available. Please try again."
    );
    return;
  }

  // Use the original serviceUrl from the pending message for consistency
  const originalActivity: Activity = {
    ...activity,
    serviceUrl: serviceUrl || activity.serviceUrl,
    conversation: {
      ...activity.conversation,
      tenantId: tenantId || activity.conversation.tenantId,
    },
  };

  const sessionResult = await startSessionAndSendPrompt(
    env,
    repo,
    originalActivity,
    resolvedSessionKey,
    replyActivityId,
    messageText,
    traceId
  );

  if (!sessionResult) return;

  // Post-creation cleanup — wrap in try-catch so failures here don't
  // trigger a misleading "Something went wrong" error to the user when
  // the session was already created successfully.
  try {
    await env.TEAMS_KV.delete(pendingKey);

    const sessionUrl = `${env.WEB_APP_URL}/session/${sessionResult.sessionId}`;
    await sendReply(
      activity.serviceUrl,
      conversationId,
      replyActivityId,
      env.MICROSOFT_APP_ID,
      env.MICROSOFT_APP_PASSWORD,
      env.MICROSOFT_TENANT_ID,
      `Working on **${repo.fullName}**... [View Session](${sessionUrl})`
    );
  } catch (cleanupError) {
    log.error("repo_selection.post_creation_cleanup_failed", {
      trace_id: traceId,
      session_id: sessionResult.sessionId,
      error: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
    });
  }
}

// ─── Hono App ─────────────────────────────────────────────────────────────────

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
    service: "open-inspect-teams-bot",
    repoCount,
  });
});

// Bot Framework messaging endpoint
app.post("/api/messages", async (c) => {
  const startTime = Date.now();
  const traceId = crypto.randomUUID();

  // Validate Bot Framework JWT
  const authHeader = c.req.header("Authorization") ?? null;
  const isValid = await validateBotFrameworkToken(authHeader, c.env.MICROSOFT_APP_ID);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/api/messages",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_token",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "Unauthorized" }, 401);
  }

  const activity = (await c.req.json()) as Activity;

  // Deduplicate activities
  const dedupeKey = `activity:${activity.id}`;
  const existing = await c.env.TEAMS_KV.get(dedupeKey);
  if (existing) {
    log.debug("teams.activity.duplicate", { trace_id: traceId, activity_id: activity.id });
    return c.json({}, 200);
  }
  await c.env.TEAMS_KV.put(dedupeKey, "1", { expirationTtl: 3600 });

  // Route by activity type
  if (activity.type === "message") {
    c.executionCtx.waitUntil(handleMessage(activity, c.env, traceId));
  } else if (activity.type === "invoke") {
    c.executionCtx.waitUntil(handleInvoke(activity, c.env, traceId));
  }

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/api/messages",
    http_status: 200,
    activity_type: activity.type,
    activity_id: activity.id,
    duration_ms: Date.now() - startTime,
  });

  return c.json({}, 200);
});

// Mount callbacks router for control-plane notifications
app.route("/callbacks", callbacksRouter);

export default app;
