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
  UserPreferences,
  SlackInteractionPayload,
  PendingRepoSelection,
  PendingMessageSelection,
  PendingReactionSelection,
  SlackEvent,
  SlackReactionAddedEvent,
} from "./types";
import { stripMentions, isDmDispatchable } from "./dm-utils";
import {
  verifySlackSignature,
  postMessage,
  updateMessage,
  addReaction,
  getChannelInfo,
  getThreadMessages,
  getMessageByTimestamp,
  publishView,
  openView,
} from "./utils/slack-client";
import { resolveUserNames } from "./utils/resolve-users";
import { createClassifier } from "./classifier";
import { getAvailableRepos } from "./classifier/repos";
import { callbacksRouter } from "./callbacks";
import { buildInternalAuthHeaders } from "./utils/internal";
import { createLogger } from "./logger";
import {
  BRANCH_MODAL_CALLBACK_ID,
  REPO_BRANCH_MODAL_CALLBACK_ID,
  BRANCH_INPUT_BLOCK_ID,
  BRANCH_INPUT_ACTION_ID,
  REPO_BRANCH_SELECTOR_ACTION_ID,
  CLEAR_REPO_BRANCH_ACTION_ID,
  getUserRepoBranchPreference,
  getUserRepoBranchPreferences,
  saveUserRepoBranchPreference,
  normalizeBranchPreference,
  isValidBranchName,
  getValidatedBranch,
  isBranchModalCallbackId,
  getSubmittedBranch,
  getBranchSubmissionValidationError,
} from "./branch-preferences";
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

const MAX_REPO_SUGGESTION_OPTIONS = 100;
const THREAD_SESSION_TTL_SECONDS = 86400;
const PENDING_REPO_SELECTION_TTL_SECONDS = 3600;
const SESSION_TITLE_LIMIT = 100;
const THREAD_CONTEXT_LIMIT = 10;
const REACTION_PROGRESS_NAME = "eyes";
const NO_MESSAGE_TEXT = "[No message text available]";

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
  title: string | undefined,
  model: string,
  reasoningEffort: string | undefined,
  branch: string | undefined,
  traceId?: string
): Promise<{ sessionId: string; status: string } | null> {
  const startTime = Date.now();
  const base = {
    trace_id: traceId,
    repo_owner: repo.owner,
    repo_name: repo.name,
    model,
    reasoning_effort: reasoningEffort,
    branch,
  };
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch("https://internal/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        repoOwner: repo.owner,
        repoName: repo.name,
        title: title || `Slack: ${repo.name}`,
        model,
        reasoningEffort,
        branch,
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
    const data = await env.SLACK_KV.get(key, "json");
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
    await env.SLACK_KV.put(key, JSON.stringify(session), {
      expirationTtl: THREAD_SESSION_TTL_SECONDS,
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
    await env.SLACK_KV.delete(key);
  } catch (e) {
    log.error("kv.delete", {
      key_prefix: "thread",
      channel,
      thread_ts: threadTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

function getPendingRepoSelectionKey(channel: string, threadTsOrMessageTs: string): string {
  return `pending:${channel}:${threadTsOrMessageTs}`;
}

function getInvestigateReactionConfig(env: Env, traceId?: string): string | null {
  const reaction = env.SLACK_INVESTIGATE_REACTION?.trim();

  if (!reaction) {
    log.error("slack.reaction.config.invalid", {
      trace_id: traceId,
      has_reaction: Boolean(reaction),
    });
    return null;
  }

  return reaction;
}

type SessionLookupOutcome = "active" | "missing" | "error";

async function getSessionLookupOutcome(
  env: Env,
  sessionId: string,
  traceId?: string
): Promise<SessionLookupOutcome> {
  const startTime = Date.now();
  try {
    const headers = await getAuthHeaders(env, traceId);
    const response = await env.CONTROL_PLANE.fetch(`https://internal/sessions/${sessionId}`, {
      method: "GET",
      headers,
    });

    if (response.status === 404) {
      log.warn("control_plane.get_session", {
        trace_id: traceId,
        session_id: sessionId,
        outcome: "missing",
        http_status: 404,
        duration_ms: Date.now() - startTime,
      });
      return "missing";
    }

    if (!response.ok) {
      log.error("control_plane.get_session", {
        trace_id: traceId,
        session_id: sessionId,
        outcome: "error",
        http_status: response.status,
        duration_ms: Date.now() - startTime,
      });
      return "error";
    }

    log.info("control_plane.get_session", {
      trace_id: traceId,
      session_id: sessionId,
      outcome: "success",
      http_status: 200,
      duration_ms: Date.now() - startTime,
    });
    return "active";
  } catch (error) {
    log.error("control_plane.get_session", {
      trace_id: traceId,
      session_id: sessionId,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    return "error";
  }
}

/**
 * Derive flat model options from shared MODEL_OPTIONS for Slack dropdowns.
 */
const ALL_MODELS = MODEL_OPTIONS.flatMap((group) =>
  group.models.map((m) => ({
    label: `${m.name} (${m.description})`,
    value: m.id,
  }))
);

/**
 * Fetch enabled models from the control plane, falling back to defaults.
 */
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

/**
 * Generate a consistent KV key for user preferences.
 */
function getUserPreferencesKey(userId: string): string {
  return `user_prefs:${userId}`;
}

/**
 * Type guard to validate UserPreferences shape from KV.
 */
function isValidUserPreferences(data: unknown): data is UserPreferences {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const obj = data as Record<string, unknown>;
  const branchValid = obj.branch === undefined || typeof obj.branch === "string";
  return (
    typeof obj.userId === "string" &&
    typeof obj.model === "string" &&
    typeof obj.updatedAt === "number" &&
    branchValid
  );
}

/**
 * Look up user preferences from KV.
 */
async function getUserPreferences(env: Env, userId: string): Promise<UserPreferences | null> {
  try {
    const key = getUserPreferencesKey(userId);
    const data = await env.SLACK_KV.get(key, "json");
    if (isValidUserPreferences(data)) {
      return data;
    }
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

/**
 * Save user preferences to KV.
 * @returns true if saved successfully, false otherwise
 */
async function saveUserPreferences(
  env: Env,
  userId: string,
  model: string,
  reasoningEffort?: string,
  branch?: string
): Promise<boolean> {
  try {
    const key = getUserPreferencesKey(userId);
    const normalizedBranch = normalizeBranchPreference(branch);
    if (normalizedBranch && !isValidBranchName(normalizedBranch)) {
      log.warn("slack.branch_pref.invalid", {
        user_id: userId,
        branch: normalizedBranch,
      });
      return false;
    }
    const prefs: UserPreferences = {
      userId,
      model,
      reasoningEffort,
      branch: normalizedBranch,
      updatedAt: Date.now(),
    };
    // No TTL - preferences persist indefinitely
    await env.SLACK_KV.put(key, JSON.stringify(prefs));
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

/**
 * Build Slack select options for repositories with optional branch labels.
 */
function buildRepoBranchSelectOptions(
  repos: RepoConfig[],
  repoBranchPreferences: Map<string, string>
): Array<{ text: { type: "plain_text"; text: string }; value: string }> {
  return repos.map((repo) => {
    const repoBranch = repoBranchPreferences.get(repo.id);
    const label = repoBranch ? `${repo.fullName} → ${repoBranch}` : repo.fullName;
    return {
      text: {
        type: "plain_text" as const,
        text: label.slice(0, 75),
      },
      value: repo.id,
    };
  });
}

/**
 * Build searchable repository options for Slack external_select.
 */
async function getRepoBranchSuggestionOptions(
  env: Env,
  userId: string,
  query: string | undefined,
  traceId?: string
): Promise<Array<{ text: { type: "plain_text"; text: string }; value: string }>> {
  const repos = await getAvailableRepos(env, traceId);
  const repoBranchPreferences = await getUserRepoBranchPreferences(env, userId);
  const normalizedQuery = query?.trim().toLowerCase();

  const filteredRepos = normalizedQuery
    ? repos.filter((repo) => repo.fullName.toLowerCase().includes(normalizedQuery))
    : repos;

  return buildRepoBranchSelectOptions(filteredRepos, repoBranchPreferences).slice(
    0,
    MAX_REPO_SUGGESTION_OPTIONS
  );
}

/**
 * Publish the App Home view for a user.
 */
async function publishAppHome(env: Env, userId: string): Promise<void> {
  const prefs = await getUserPreferences(env, userId);
  const fallback = env.DEFAULT_MODEL || DEFAULT_MODEL;
  // Normalize model to ensure it's valid - UI and behavior will be consistent
  const currentModel = getValidModelOrDefault(prefs?.model ?? fallback);
  const availableModels = await getAvailableModels(env);
  const currentModelInfo =
    availableModels.find((m) => m.value === currentModel) || availableModels[0];

  // Determine reasoning effort options for the current model
  const reasoningConfig = getReasoningConfig(currentModel);
  const currentEffort =
    prefs?.reasoningEffort && isValidReasoningEffort(currentModel, prefs.reasoningEffort)
      ? prefs.reasoningEffort
      : getDefaultReasoningEffort(currentModel);
  const currentBranch = getValidatedBranch(prefs?.branch);

  const repos = await getAvailableRepos(env);
  const repoBranchPreferences = await getUserRepoBranchPreferences(env, userId);

  const reasoningOptions = reasoningConfig
    ? reasoningConfig.efforts.map((effort) => ({
        text: { type: "plain_text" as const, text: effort },
        value: effort,
      }))
    : [];

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: "Settings" },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Configure your Open-Inspect preferences below.",
      },
    },
    { type: "divider" },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Model*\nSelect the model for your coding sessions:",
      },
    },
    {
      type: "actions",
      block_id: "model_selection",
      elements: [
        {
          type: "static_select",
          action_id: "select_model",
          initial_option: {
            text: { type: "plain_text", text: currentModelInfo.label },
            value: currentModelInfo.value,
          },
          options: availableModels.map((m) => ({
            text: { type: "plain_text", text: m.label },
            value: m.value,
          })),
        },
      ],
    },
  ];

  // Add reasoning effort dropdown if the model supports it
  if (reasoningConfig) {
    const currentEffortOption = reasoningOptions.find((o) => o.value === currentEffort);
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Reasoning Effort*\nControl the depth of reasoning for your sessions:",
        },
      },
      {
        type: "actions",
        block_id: "reasoning_selection",
        elements: [
          {
            type: "static_select",
            action_id: "select_reasoning_effort",
            ...(currentEffortOption ? { initial_option: currentEffortOption } : {}),
            placeholder: { type: "plain_text" as const, text: "Select effort" },
            options: reasoningOptions,
          },
        ],
      }
    );
  }

  blocks.push(
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Branch (optional)*\nSet a default branch for new Slack sessions. Leave empty to use each repository default branch.",
      },
      accessory: {
        type: "button",
        action_id: "open_branch_modal",
        text: { type: "plain_text", text: currentBranch ? "Edit branch" : "Set branch" },
        value: "open_branch_modal",
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: currentBranch
            ? `Branch override: *${currentBranch}*`
            : "Branch override: *(repo default)*",
        },
      ],
    }
  );

  if (currentBranch) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "clear_branch_preference",
          text: { type: "plain_text", text: "Clear branch override" },
          style: "danger",
          value: "clear_branch_preference",
        },
      ],
    });
  }

  if (repos.length > 0) {
    const configuredRepoOverrides = repos
      .map((repo) => ({ repo, branch: repoBranchPreferences.get(repo.id) }))
      .filter((entry): entry is { repo: RepoConfig; branch: string } => Boolean(entry.branch));

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Branch by repository*\nChoose a repository to set a repo-specific branch override.",
        },
      },
      {
        type: "actions",
        block_id: "repo_branch_selection",
        elements: [
          {
            type: "external_select",
            action_id: REPO_BRANCH_SELECTOR_ACTION_ID,
            placeholder: { type: "plain_text", text: "Search repository" },
            min_query_length: 0,
          },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Priority: repo-specific override → global override → repository default branch.",
          },
        ],
      }
    );

    if (configuredRepoOverrides.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Configured repo overrides*",
        },
      });

      for (const { repo, branch } of configuredRepoOverrides) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\`${repo.fullName}\` → *${branch}*`,
          },
          accessory: {
            type: "button",
            action_id: CLEAR_REPO_BRANCH_ACTION_ID,
            text: { type: "plain_text", text: "Delete" },
            style: "danger",
            value: repo.id,
            confirm: {
              title: { type: "plain_text", text: "Delete override?" },
              text: {
                type: "mrkdwn",
                text: `Remove branch override for *${repo.fullName}*?`,
              },
              confirm: { type: "plain_text", text: "Delete" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
        });
      }
    }
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Currently using: *${currentModelInfo.label}*${currentEffort ? ` · ${currentEffort}` : ""}${currentBranch ? ` · branch:${currentBranch}` : ""}`,
      },
    ],
  });

  const view = {
    type: "home",
    blocks,
  };

  const result = await publishView(env.SLACK_BOT_TOKEN, userId, view);
  if (!result.ok) {
    log.error("slack.app_home", { user_id: userId, outcome: "error", slack_error: result.error });
  }
}

/**
 * Open a modal to set or clear a user's branch preference.
 */
async function openBranchPreferenceModal(
  env: Env,
  userId: string,
  triggerId: string,
  currentBranch?: string
): Promise<void> {
  const view = {
    type: "modal",
    callback_id: BRANCH_MODAL_CALLBACK_ID,
    title: {
      type: "plain_text",
      text: "Branch Preference",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    private_metadata: JSON.stringify({ userId }),
    blocks: [
      {
        type: "input",
        block_id: BRANCH_INPUT_BLOCK_ID,
        optional: true,
        label: {
          type: "plain_text",
          text: "Default branch for new Slack sessions",
        },
        element: {
          type: "plain_text_input",
          action_id: BRANCH_INPUT_ACTION_ID,
          initial_value: currentBranch || "",
          placeholder: {
            type: "plain_text",
            text: "e.g. main, staging, release/2026-03",
          },
        },
        hint: {
          type: "plain_text",
          text: "Leave empty to use each repository's default branch.",
        },
      },
    ],
  };

  const result = await openView(env.SLACK_BOT_TOKEN, triggerId, view);
  if (!result.ok) {
    log.error("slack.open_branch_modal", {
      user_id: userId,
      outcome: "error",
      slack_error: result.error,
    });
  }
}

/**
 * Open a modal to set or clear a user's branch preference for a specific repository.
 */
async function openRepoBranchPreferenceModal(
  env: Env,
  userId: string,
  triggerId: string,
  repo: RepoConfig,
  currentBranch?: string
): Promise<void> {
  const view = {
    type: "modal",
    callback_id: REPO_BRANCH_MODAL_CALLBACK_ID,
    title: {
      type: "plain_text",
      text: "Repo Branch",
    },
    submit: {
      type: "plain_text",
      text: "Save",
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
    private_metadata: JSON.stringify({ userId, repoId: repo.id }),
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Repository: *${repo.fullName}*`,
        },
      },
      {
        type: "input",
        block_id: BRANCH_INPUT_BLOCK_ID,
        optional: true,
        label: {
          type: "plain_text",
          text: "Branch override",
        },
        element: {
          type: "plain_text_input",
          action_id: BRANCH_INPUT_ACTION_ID,
          initial_value: currentBranch || "",
          placeholder: {
            type: "plain_text",
            text: "e.g. main, staging, release/2026-03",
          },
        },
        hint: {
          type: "plain_text",
          text: "Leave empty to clear this repository override.",
        },
      },
    ],
  };

  const result = await openView(env.SLACK_BOT_TOKEN, triggerId, view);
  if (!result.ok) {
    log.error("slack.open_repo_branch_modal", {
      user_id: userId,
      repo_id: repo.id,
      outcome: "error",
      slack_error: result.error,
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
 * Normalize Slack message text for prompt construction.
 */
function normalizeSlackMessageText(text?: string): string {
  const trimmed = text?.trim();
  if (!trimmed) {
    return NO_MESSAGE_TEXT;
  }
  return trimmed;
}

/**
 * Build a short session title from Slack content.
 */
function buildSlackSessionTitle(prefix: string, text: string): string {
  const trimmed = normalizeSlackMessageText(text);
  return `${prefix}: ${trimmed}`.slice(0, SESSION_TITLE_LIMIT);
}

/**
 * Format thread context for inclusion in a prompt.
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
 */
function formatChannelContext(channelName: string, channelDescription?: string): string {
  let context = `Slack channel context:\n---\nChannel: #${channelName}`;
  if (channelDescription) {
    context += `\nDescription: ${channelDescription}`;
  }
  context += "\n---\n\n";
  return context;
}

/**
 * Build prompt content from channel/thread context plus the user's message.
 */
function buildPromptContent(
  messageText: string,
  previousMessages?: string[],
  channelName?: string,
  channelDescription?: string
): string {
  const channelContext = channelName ? formatChannelContext(channelName, channelDescription) : "";
  const threadContext = previousMessages ? formatThreadContext(previousMessages) : "";
  return channelContext + threadContext + normalizeSlackMessageText(messageText);
}

/**
 * Build the Slack investigation prompt for reaction-triggered alerts.
 */
function buildInvestigationPrompt(params: {
  channelId: string;
  channelName?: string;
  triggeringUserName: string;
  primaryAlertText: string;
  reactedReplyText?: string;
  previousMessages?: string[];
}): string {
  const channelLabel = params.channelName ? `#${params.channelName}` : params.channelId;
  const sections = [
    "Investigate the Slack alert below.",
    "",
    `Channel: ${channelLabel}`,
    `Triggered by: ${params.triggeringUserName}`,
    "",
    "Primary alert message:",
    normalizeSlackMessageText(params.primaryAlertText),
  ];

  if (params.reactedReplyText) {
    sections.push("", "Reacted thread reply:", normalizeSlackMessageText(params.reactedReplyText));
  }

  if (params.previousMessages?.length) {
    sections.push("", "Thread context:", params.previousMessages.join("\n"));
  }

  sections.push(
    "",
    "Please investigate the likely cause, summarize your findings, and propose or implement a fix if the repository and evidence make that appropriate."
  );

  return sections.join("\n");
}

interface UserSessionSettings {
  model: string;
  reasoningEffort?: string;
  branch?: string;
}

async function getUserSessionSettings(
  env: Env,
  userId: string,
  repoId: string
): Promise<UserSessionSettings> {
  const userPrefs = await getUserPreferences(env, userId);
  const fallback = env.DEFAULT_MODEL || DEFAULT_MODEL;
  const model = getValidModelOrDefault(userPrefs?.model ?? fallback);
  const reasoningEffort =
    userPrefs?.reasoningEffort && isValidReasoningEffort(model, userPrefs.reasoningEffort)
      ? userPrefs.reasoningEffort
      : getDefaultReasoningEffort(model);
  const globalBranch = getValidatedBranch(userPrefs?.branch);
  const repoBranch = await getUserRepoBranchPreference(env, userId, repoId);
  return {
    model,
    reasoningEffort,
    branch: repoBranch ?? globalBranch,
  };
}

function buildSlackCallbackContext(params: {
  channel: string;
  threadTs: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  reactionMessageTs?: string;
}): CallbackContext {
  return {
    source: "slack",
    channel: params.channel,
    threadTs: params.threadTs,
    repoFullName: params.repoFullName,
    model: params.model,
    reasoningEffort: params.reasoningEffort,
    reactionMessageTs: params.reactionMessageTs,
  };
}

interface CreateSlackSessionAndPromptParams {
  env: Env;
  repo: RepoConfig;
  channel: string;
  threadTs: string;
  sessionTitle: string;
  promptContent: string;
  userId: string;
  reactionMessageTs?: string;
  traceId?: string;
}

/**
 * Create a Slack-backed session, store the thread mapping, and enqueue the prompt.
 */
async function createSlackSessionAndSendPrompt(
  params: CreateSlackSessionAndPromptParams
): Promise<{ sessionId: string } | null> {
  const {
    env,
    repo,
    channel,
    threadTs,
    sessionTitle,
    promptContent,
    userId,
    reactionMessageTs,
    traceId,
  } = params;
  const userSessionSettings = await getUserSessionSettings(env, userId, repo.id);
  const session = await createSession(
    env,
    repo,
    sessionTitle,
    userSessionSettings.model,
    userSessionSettings.reasoningEffort,
    userSessionSettings.branch,
    traceId
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
    buildThreadSession(
      session.sessionId,
      repo,
      userSessionSettings.model,
      userSessionSettings.reasoningEffort
    )
  );

  const callbackContext = buildSlackCallbackContext({
    channel,
    threadTs,
    repoFullName: repo.fullName,
    model: userSessionSettings.model,
    reasoningEffort: userSessionSettings.reasoningEffort,
    reactionMessageTs,
  });

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

/**
 * Post the initial "working on it" acknowledgement to Slack.
 */
async function postWorkingAckMessage(
  env: Env,
  channel: string,
  threadTs: string,
  repoFullName: string,
  reasoning: string
): Promise<string | undefined> {
  const ackResult = await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    `Working on *${repoFullName}*...`,
    {
      thread_ts: threadTs,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Working on *${repoFullName}*...\n_${reasoning}_`,
          },
        },
      ],
    }
  );

  return ackResult.ts;
}

/**
 * Update the acknowledgement message with a session link.
 */
async function updateWorkingAckMessage(
  env: Env,
  channel: string,
  ackTs: string | undefined,
  repoFullName: string,
  reasoning: string,
  sessionId: string
): Promise<void> {
  if (!ackTs) {
    return;
  }

  await updateMessage(env.SLACK_BOT_TOKEN, channel, ackTs, `Working on *${repoFullName}*...`, {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `Working on *${repoFullName}*...\n_${reasoning}_`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Session",
            },
            url: `${env.WEB_APP_URL}/session/${sessionId}`,
            action_id: "view_session",
          },
        ],
      },
    ],
  });
}

/**
 * Post the "session started" notification to Slack.
 */
async function postSessionStartedMessage(
  env: Env,
  channel: string,
  threadTs: string,
  sessionId: string
): Promise<void> {
  await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    `Session started! The agent is now working on your request.\n\nView progress: ${env.WEB_APP_URL}/session/${sessionId}`,
    { thread_ts: threadTs }
  );
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
    const existing = await c.env.SLACK_KV.get(dedupeKey);
    if (existing) {
      log.debug("slack.event.duplicate", { trace_id: traceId, event_id: eventId });
      return c.json({ ok: true });
    }
    // Mark as seen with 1 hour TTL (Slack retries are within minutes)
    await c.env.SLACK_KV.put(dedupeKey, "1", { expirationTtl: 3600 });
  }

  // Process event asynchronously
  c.executionCtx.waitUntil(handleSlackEvent(payload, c.env, traceId));

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
  const payload = JSON.parse(payloadStr) as SlackInteractionPayload;

  if (payload.type === "block_suggestion") {
    const suggestionActionId = payload.action_id;
    const suggestionUserId = payload.user?.id;

    if (suggestionActionId === REPO_BRANCH_SELECTOR_ACTION_ID && suggestionUserId) {
      const options = await getRepoBranchSuggestionOptions(
        c.env,
        suggestionUserId,
        payload.value,
        traceId
      );

      log.info("http.request", {
        trace_id: traceId,
        http_method: "POST",
        http_path: "/interactions",
        http_status: 200,
        interaction_type: payload.type,
        action_id: suggestionActionId,
        option_count: options.length,
        duration_ms: Date.now() - startTime,
      });

      return c.json({ options });
    }

    return c.json({ options: [] });
  }

  const submittedBranch = getSubmittedBranch(payload);
  const branchValidationError = getBranchSubmissionValidationError(payload);

  if (branchValidationError) {
    log.warn("slack.branch_pref.invalid", {
      trace_id: traceId,
      user_id: payload.user?.id,
      branch: submittedBranch ?? "",
    });
    log.info("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/interactions",
      http_status: 200,
      interaction_type: payload.type,
      callback_id: payload.view?.callback_id,
      outcome: "validation_error",
      duration_ms: Date.now() - startTime,
    });
    return c.json({
      response_action: "errors",
      errors: {
        [BRANCH_INPUT_BLOCK_ID]: branchValidationError,
      },
    });
  }

  const actionId = payload.actions?.[0]?.action_id ?? payload.action_id;
  const isViewSubmission = payload.type === "view_submission";
  const shouldOpenModalInline =
    actionId === "open_branch_modal" || actionId === REPO_BRANCH_SELECTOR_ACTION_ID;

  if (shouldOpenModalInline) {
    await handleSlackInteraction(payload, c.env, traceId);
  } else {
    c.executionCtx.waitUntil(handleSlackInteraction(payload, c.env, traceId));
  }

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

  if (isViewSubmission && isBranchModalCallbackId(payload.view?.callback_id)) {
    return c.json({ response_action: "clear" });
  }

  return c.json({ ok: true });
});

// Mount callbacks router for control-plane notifications
app.route("/callbacks", callbacksRouter);

/**
 * Handle incoming Slack events.
 */
async function handleSlackEvent(payload: SlackEvent, env: Env, traceId?: string): Promise<void> {
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

  if (event.type === "reaction_added") {
    await handleReactionAddedEvent(event as SlackReactionAddedEvent, env, traceId);
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
      traceId
    );
    return;
  }

  // Handle app_mention events
  if (event.type === "app_mention" && event.text && event.channel && event.ts) {
    await handleAppMention(event as Required<typeof event>, env, traceId);
  }
}

async function fetchChannelContext(
  env: Env,
  channelId: string
): Promise<{ channelName?: string; channelDescription?: string }> {
  try {
    const channelInfo = await getChannelInfo(env.SLACK_BOT_TOKEN, channelId);
    if (!channelInfo.ok || !channelInfo.channel) {
      return {};
    }

    return {
      channelName: channelInfo.channel.name,
      channelDescription: channelInfo.channel.topic?.value || channelInfo.channel.purpose?.value,
    };
  } catch {
    return {};
  }
}

async function fetchFormattedThreadMessages(
  env: Env,
  channel: string,
  threadTs: string,
  excludeTs?: string
): Promise<string[] | undefined> {
  try {
    const threadResult = await getThreadMessages(
      env.SLACK_BOT_TOKEN,
      channel,
      threadTs,
      THREAD_CONTEXT_LIMIT + 1
    );
    if (!threadResult.ok || !threadResult.messages) {
      return undefined;
    }

    const filtered = excludeTs
      ? threadResult.messages.filter((message) => message.ts !== excludeTs)
      : threadResult.messages;

    if (filtered.length === 0) {
      return undefined;
    }

    const uniqueUserIds = [
      ...new Set(filtered.map((message) => message.user).filter(Boolean)),
    ] as string[];
    const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, uniqueUserIds);
    return filtered
      .map((message) => {
        if (message.bot_id) {
          return `[Bot]: ${normalizeSlackMessageText(message.text)}`;
        }
        const name = message.user ? userNames.get(message.user) || message.user : "Unknown";
        return `[${name}]: ${normalizeSlackMessageText(message.text)}`;
      })
      .slice(-THREAD_CONTEXT_LIMIT);
  } catch {
    return undefined;
  }
}

function buildRepoSelectionOptions(repos: RepoConfig[]): Array<{
  text: { type: "plain_text"; text: string };
  description: { type: "plain_text"; text: string };
  value: string;
}> {
  return repos.map((repo) => ({
    text: {
      type: "plain_text" as const,
      text: repo.displayName,
    },
    description: {
      type: "plain_text" as const,
      text: repo.description.slice(0, 75),
    },
    value: repo.id,
  }));
}

async function storePendingRepoSelection(
  env: Env,
  channel: string,
  threadTsOrMessageTs: string,
  payload: PendingRepoSelection
): Promise<void> {
  await env.SLACK_KV.put(
    getPendingRepoSelectionKey(channel, threadTsOrMessageTs),
    JSON.stringify(payload),
    { expirationTtl: PENDING_REPO_SELECTION_TTL_SECONDS }
  );
}

function isPendingRepoSelection(data: unknown): data is PendingRepoSelection {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }

  const record = data as Record<string, unknown>;
  if (record.kind === "message") {
    return typeof record.message === "string" && typeof record.userId === "string";
  }

  if (record.kind === "reaction") {
    return (
      typeof record.userId === "string" &&
      typeof record.promptContent === "string" &&
      typeof record.sessionTitle === "string" &&
      typeof record.reactionMessageTs === "string" &&
      typeof record.rootThreadTs === "string"
    );
  }

  return false;
}

async function postRepoSelectionMessage(
  env: Env,
  channel: string,
  threadTs: string,
  reasoning: string,
  repos: RepoConfig[]
): Promise<void> {
  await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    `I couldn't determine which repository you're referring to. ${reasoning}`,
    {
      thread_ts: threadTs,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `I couldn't determine which repository you're referring to.\n\n_${reasoning}_`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Which repository should I work with?",
          },
          accessory: {
            type: "static_select",
            placeholder: {
              type: "plain_text",
              text: "Select a repository",
            },
            options: buildRepoSelectionOptions(repos),
            action_id: "select_repo",
          },
        },
      ],
    }
  );
}

async function addProgressReaction(
  env: Env,
  channel: string,
  messageTs: string,
  traceId?: string
): Promise<void> {
  const reactionResult = await addReaction(
    env.SLACK_BOT_TOKEN,
    channel,
    messageTs,
    REACTION_PROGRESS_NAME
  );
  if (!reactionResult.ok && reactionResult.error !== "already_reacted") {
    log.warn("slack.reaction.add", {
      trace_id: traceId,
      channel,
      message_ts: messageTs,
      reaction: REACTION_PROGRESS_NAME,
      slack_error: reactionResult.error,
    });
  }
}

function logIgnoredInvestigateReaction(
  reason: string,
  event: Partial<SlackReactionAddedEvent>,
  traceId?: string
): void {
  log.info("slack.reaction.investigate.ignored", {
    trace_id: traceId,
    reason,
    reaction: event.reaction,
    channel: event.item?.channel,
    message_ts: event.item?.ts,
    user: event.user,
  });
}

async function handleReactionAddedEvent(
  event: SlackReactionAddedEvent,
  env: Env,
  traceId?: string
): Promise<void> {
  const config = getInvestigateReactionConfig(env, traceId);
  if (!config) {
    return;
  }

  if (event.reaction !== config) {
    logIgnoredInvestigateReaction("unsupported_reaction", event, traceId);
    return;
  }

  if (event.item?.type !== "message") {
    logIgnoredInvestigateReaction("unsupported_item_type", event, traceId);
    return;
  }

  if (!event.item.channel || !event.item.ts || !event.user) {
    logIgnoredInvestigateReaction("missing_event_fields", event, traceId);
    return;
  }

  const channel = event.item.channel;
  const reactionMessageTs = event.item.ts;
  log.info("slack.reaction.investigate.accepted", {
    trace_id: traceId,
    channel,
    message_ts: reactionMessageTs,
    reaction: event.reaction,
    user: event.user,
  });

  const messageResult = await getMessageByTimestamp(
    env.SLACK_BOT_TOKEN,
    channel,
    reactionMessageTs
  );
  if (!messageResult.ok) {
    log.error("slack.reaction.message_fetch", {
      trace_id: traceId,
      channel,
      message_ts: reactionMessageTs,
      outcome: "error",
      slack_error: messageResult.error,
    });
    return;
  }

  if (!messageResult.message) {
    log.warn("slack.reaction.message_fetch", {
      trace_id: traceId,
      channel,
      message_ts: reactionMessageTs,
      outcome: "missing",
    });
    return;
  }

  const rootThreadTs = messageResult.message.thread_ts ?? messageResult.message.ts;
  const existingSession = await lookupThreadSession(env, channel, rootThreadTs);
  if (existingSession) {
    const outcome = await getSessionLookupOutcome(env, existingSession.sessionId, traceId);
    if (outcome === "active") {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        `An investigation already exists for this alert.\n\nView progress: ${env.WEB_APP_URL}/session/${existingSession.sessionId}`,
        { thread_ts: rootThreadTs }
      );
      return;
    }

    if (outcome === "error") {
      return;
    }

    await clearThreadSession(env, channel, rootThreadTs);
  }

  const { channelName, channelDescription } = await fetchChannelContext(env, channel);
  const previousMessages = await fetchFormattedThreadMessages(
    env,
    channel,
    rootThreadTs,
    reactionMessageTs
  );
  const userNames = await resolveUserNames(env.SLACK_BOT_TOKEN, [event.user]);
  const triggeringUserName = userNames.get(event.user) || event.user;
  const primaryAlertText = normalizeSlackMessageText(messageResult.message.text);
  const reactedReplyText = messageResult.message.thread_ts
    ? normalizeSlackMessageText(messageResult.message.text)
    : undefined;
  const promptContent = buildInvestigationPrompt({
    channelId: channel,
    channelName,
    triggeringUserName,
    primaryAlertText,
    reactedReplyText,
    previousMessages,
  });
  const sessionTitle = buildSlackSessionTitle("Slack alert", primaryAlertText);

  const classifier = createClassifier(env);
  const result = await classifier.classify(
    primaryAlertText,
    {
      channelId: channel,
      channelName,
      channelDescription,
      threadTs: rootThreadTs,
      previousMessages,
    },
    traceId
  );

  if (result.needsClarification || !result.repo) {
    const repos = await getAvailableRepos(env, traceId);
    if (repos.length === 0) {
      await postMessage(
        env.SLACK_BOT_TOKEN,
        channel,
        "Sorry, no repositories are currently available. Please check that the GitHub App is installed and configured.",
        { thread_ts: rootThreadTs }
      );
      return;
    }

    const pendingSelection: PendingReactionSelection = {
      kind: "reaction",
      userId: event.user,
      promptContent,
      sessionTitle,
      reactionMessageTs,
      rootThreadTs,
    };
    const repoOptions = result.alternatives?.length
      ? result.alternatives.slice(0, 5)
      : repos.slice(0, 5);
    await storePendingRepoSelection(env, channel, rootThreadTs, pendingSelection);
    await postRepoSelectionMessage(
      env,
      channel,
      rootThreadTs,
      result.reasoning,
      repoOptions.length > 0 ? repoOptions : repos.slice(0, 5)
    );
    return;
  }

  const ackTs = await postWorkingAckMessage(
    env,
    channel,
    rootThreadTs,
    result.repo.fullName,
    result.reasoning
  );
  const sessionResult = await createSlackSessionAndSendPrompt({
    env,
    repo: result.repo,
    channel,
    threadTs: rootThreadTs,
    sessionTitle,
    promptContent,
    userId: event.user,
    reactionMessageTs,
    traceId,
  });

  if (!sessionResult) {
    return;
  }

  await updateWorkingAckMessage(
    env,
    channel,
    ackTs,
    result.repo.fullName,
    result.reasoning,
    sessionResult.sessionId
  );
  await addProgressReaction(env, channel, reactionMessageTs, traceId);
  await postSessionStartedMessage(env, channel, rootThreadTs, sessionResult.sessionId);
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
 * - Session started message
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
  } = params;

  if (!messageText.trim()) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Hi! Please include a message with your request.",
      { thread_ts: threadTs || ts }
    );
    return;
  }

  const previousMessages = threadTs
    ? await fetchFormattedThreadMessages(env, channel, threadTs, ts)
    : undefined;

  if (threadTs) {
    const existingSession = await lookupThreadSession(env, channel, threadTs);
    if (existingSession) {
      const callbackContext = buildSlackCallbackContext({
        channel,
        threadTs,
        repoFullName: existingSession.repoFullName,
        model: existingSession.model,
        reasoningEffort: existingSession.reasoningEffort,
        reactionMessageTs: ts,
      });
      const promptContent = buildPromptContent(
        messageText,
        previousMessages,
        channelName,
        channelDescription
      );

      const promptResult = await sendPrompt(
        env,
        existingSession.sessionId,
        promptContent,
        `slack:${user}`,
        callbackContext,
        traceId
      );

      if (promptResult) {
        await addProgressReaction(env, channel, ts, traceId);
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

    const pendingSelection: PendingMessageSelection = {
      kind: "message",
      message: messageText,
      userId: user,
      previousMessages,
      channelName,
      channelDescription,
    };
    const repoOptions = result.alternatives?.length
      ? result.alternatives.slice(0, 5)
      : repos.slice(0, 5);
    await storePendingRepoSelection(env, channel, threadTs || ts, pendingSelection);
    await postRepoSelectionMessage(
      env,
      channel,
      threadTs || ts,
      result.reasoning,
      repoOptions.length > 0 ? repoOptions : repos.slice(0, 5)
    );
    return;
  }

  const { repo } = result;
  const threadKey = threadTs || ts;
  const promptContent = buildPromptContent(
    messageText,
    previousMessages,
    channelName,
    channelDescription
  );
  const ackTs = await postWorkingAckMessage(
    env,
    channel,
    threadKey,
    repo.fullName,
    result.reasoning
  );
  const sessionResult = await createSlackSessionAndSendPrompt({
    env,
    repo,
    channel,
    threadTs: threadKey,
    sessionTitle: buildSlackSessionTitle("Slack", messageText),
    promptContent,
    userId: user,
    traceId,
  });

  if (!sessionResult) {
    return;
  }

  await updateWorkingAckMessage(
    env,
    channel,
    ackTs,
    repo.fullName,
    result.reasoning,
    sessionResult.sessionId
  );
  await postSessionStartedMessage(env, channel, threadKey, sessionResult.sessionId);
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
  traceId?: string
): Promise<void> {
  const messageText = stripMentions(event.text);
  const { channelName, channelDescription } = await fetchChannelContext(env, event.channel);

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
  traceId?: string
): Promise<void> {
  log.info("slack.dm.received", { trace_id: traceId, user: event.user, channel: event.channel });

  // Strip any @mentions (users may type "@Bot <request>" in DMs)
  const messageText = stripMentions(event.text);

  await handleIncomingMessage({
    text: messageText,
    user: event.user,
    channel: event.channel,
    ts: event.ts,
    threadTs: event.thread_ts,
    env,
    traceId,
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
  actingUserId: string,
  env: Env,
  traceId?: string
): Promise<void> {
  const threadKey = threadTs || messageTs;
  const pendingKey = getPendingRepoSelectionKey(channel, threadKey);
  const pendingData = await env.SLACK_KV.get(pendingKey, "json");

  if (!pendingData || typeof pendingData !== "object") {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't find your original request. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }
  if (!isPendingRepoSelection(pendingData)) {
    log.warn("slack.pending.invalid", {
      trace_id: traceId,
      channel,
      thread_ts: threadKey,
    });
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, I couldn't find your original request. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }
  const pendingSelection = pendingData as PendingRepoSelection;

  if (pendingSelection.userId !== actingUserId) {
    log.warn("slack.pending.user_mismatch", {
      trace_id: traceId,
      channel,
      thread_ts: threadKey,
      expected_user_id: pendingSelection.userId,
      acting_user_id: actingUserId,
    });
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Only the user who started this investigation can choose the repository.",
      { thread_ts: threadKey }
    );
    return;
  }

  const repos = await getAvailableRepos(env, traceId);
  const repo = repos.find((r) => r.id === repoId);

  if (!repo) {
    await postMessage(
      env.SLACK_BOT_TOKEN,
      channel,
      "Sorry, that repository is no longer available. Please try again.",
      { thread_ts: threadKey }
    );
    return;
  }

  const userId = pendingSelection.userId;
  let promptContent: string;
  let sessionTitle: string;
  let reactionMessageTs: string | undefined;
  const reasoning = "Repository selected manually.";

  if (pendingSelection.kind === "reaction") {
    promptContent = pendingSelection.promptContent;
    sessionTitle = pendingSelection.sessionTitle;
    reactionMessageTs = pendingSelection.reactionMessageTs;
    if (pendingSelection.rootThreadTs !== threadKey) {
      log.warn("slack.pending.thread_mismatch", {
        trace_id: traceId,
        channel,
        expected_thread_ts: pendingSelection.rootThreadTs,
        actual_thread_ts: threadKey,
      });
    }
  } else {
    promptContent = buildPromptContent(
      pendingSelection.message,
      pendingSelection.previousMessages,
      pendingSelection.channelName,
      pendingSelection.channelDescription
    );
    sessionTitle = buildSlackSessionTitle("Slack", pendingSelection.message);
  }

  const ackTs = await postWorkingAckMessage(env, channel, threadKey, repo.fullName, reasoning);
  const sessionResult = await createSlackSessionAndSendPrompt({
    env,
    repo,
    channel,
    threadTs: threadKey,
    sessionTitle,
    promptContent,
    userId,
    reactionMessageTs,
    traceId,
  });

  if (!sessionResult) {
    return;
  }

  await env.SLACK_KV.delete(pendingKey);
  await updateWorkingAckMessage(
    env,
    channel,
    ackTs,
    repo.fullName,
    reasoning,
    sessionResult.sessionId
  );
  if (reactionMessageTs) {
    await addProgressReaction(env, channel, reactionMessageTs, traceId);
  }
  await postSessionStartedMessage(env, channel, threadKey, sessionResult.sessionId);
}

/**
 * Handle Slack interactions (buttons, select menus, etc.)
 */
async function handleSlackInteraction(
  payload: SlackInteractionPayload,
  env: Env,
  traceId?: string
): Promise<void> {
  const userId = payload.user?.id;

  if (payload.type === "view_submission") {
    if (!isBranchModalCallbackId(payload.view?.callback_id) || !userId) {
      return;
    }

    const branchRaw =
      payload.view?.state?.values?.[BRANCH_INPUT_BLOCK_ID]?.[BRANCH_INPUT_ACTION_ID]?.value;
    const branch = normalizeBranchPreference(branchRaw);

    if (branch && !isValidBranchName(branch)) {
      log.warn("slack.branch_pref.invalid", {
        trace_id: traceId,
        user_id: userId,
        branch,
      });
      return;
    }

    if (payload.view?.callback_id === BRANCH_MODAL_CALLBACK_ID) {
      const currentPrefs = await getUserPreferences(env, userId);
      const model = getValidModelOrDefault(
        currentPrefs?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL
      );
      const reasoningEffort =
        currentPrefs?.reasoningEffort && isValidReasoningEffort(model, currentPrefs.reasoningEffort)
          ? currentPrefs.reasoningEffort
          : getDefaultReasoningEffort(model);

      await saveUserPreferences(env, userId, model, reasoningEffort, branch);
      await publishAppHome(env, userId);
      return;
    }

    const metadataRaw = payload.view?.private_metadata;
    let repoId: string | undefined;

    if (metadataRaw) {
      try {
        const metadata = JSON.parse(metadataRaw) as { repoId?: string; userId?: string };
        if (metadata.userId && metadata.userId !== userId) {
          log.warn("slack.repo_branch_pref.user_mismatch", {
            trace_id: traceId,
            user_id: userId,
            metadata_user_id: metadata.userId,
          });
        }
        repoId = metadata.repoId;
      } catch (error) {
        log.warn("slack.repo_branch_pref.bad_metadata", {
          trace_id: traceId,
          user_id: userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!repoId) {
      log.warn("slack.repo_branch_pref.missing_repo", { trace_id: traceId, user_id: userId });
      await publishAppHome(env, userId);
      return;
    }

    const availableRepos = await getAvailableRepos(env, traceId);
    if (!availableRepos.some((repo) => repo.id === repoId)) {
      log.warn("slack.repo_branch_pref.unknown_repo", {
        trace_id: traceId,
        user_id: userId,
        repo_id: repoId,
      });
      await publishAppHome(env, userId);
      return;
    }

    await saveUserRepoBranchPreference(env, userId, repoId, branch);
    await publishAppHome(env, userId);
    return;
  }

  if (payload.type !== "block_actions" || !payload.actions?.length) {
    return;
  }

  const action = payload.actions[0];
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts;

  switch (action.action_id) {
    case "select_model": {
      // Handle model selection from App Home
      const selectedModel = action.selected_option?.value;
      // Validate the selected model before saving
      if (selectedModel && userId && isValidModel(selectedModel)) {
        const currentPrefs = await getUserPreferences(env, userId);
        const preservedBranch = getValidatedBranch(currentPrefs?.branch);
        // Reset reasoning effort to new model's default when model changes
        const newDefault = getDefaultReasoningEffort(selectedModel);
        await saveUserPreferences(env, userId, selectedModel, newDefault, preservedBranch);
        await publishAppHome(env, userId);
      }
      break;
    }

    case "select_reasoning_effort": {
      // Handle reasoning effort selection from App Home
      const selectedEffort = action.selected_option?.value;
      if (selectedEffort && userId) {
        const currentPrefs = await getUserPreferences(env, userId);
        const currentModel = getValidModelOrDefault(
          currentPrefs?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL
        );
        const preservedBranch = getValidatedBranch(currentPrefs?.branch);
        if (isValidReasoningEffort(currentModel, selectedEffort)) {
          await saveUserPreferences(env, userId, currentModel, selectedEffort, preservedBranch);
          await publishAppHome(env, userId);
        }
      }
      break;
    }

    case "open_branch_modal": {
      if (!userId || !payload.trigger_id) return;
      const currentPrefs = await getUserPreferences(env, userId);
      const currentBranch = getValidatedBranch(currentPrefs?.branch);
      await openBranchPreferenceModal(env, userId, payload.trigger_id, currentBranch);
      break;
    }

    case REPO_BRANCH_SELECTOR_ACTION_ID: {
      if (!userId || !payload.trigger_id) return;
      const repoId = action.selected_option?.value;
      if (!repoId) return;

      const repos = await getAvailableRepos(env, traceId);
      const repo = repos.find((item) => item.id === repoId);
      if (!repo) {
        log.warn("slack.repo_branch_pref.repo_not_found", {
          trace_id: traceId,
          user_id: userId,
          repo_id: repoId,
        });
        await publishAppHome(env, userId);
        return;
      }

      const currentRepoBranch = await getUserRepoBranchPreference(env, userId, repo.id);
      await openRepoBranchPreferenceModal(env, userId, payload.trigger_id, repo, currentRepoBranch);
      break;
    }

    case CLEAR_REPO_BRANCH_ACTION_ID: {
      if (!userId) return;
      const repoId = action.value ?? action.selected_option?.value;
      if (!repoId) return;

      await saveUserRepoBranchPreference(env, userId, repoId, undefined);
      await publishAppHome(env, userId);
      break;
    }

    case "clear_branch_preference": {
      if (!userId) return;
      const currentPrefs = await getUserPreferences(env, userId);
      const model = getValidModelOrDefault(
        currentPrefs?.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL
      );
      const reasoningEffort =
        currentPrefs?.reasoningEffort && isValidReasoningEffort(model, currentPrefs.reasoningEffort)
          ? currentPrefs.reasoningEffort
          : getDefaultReasoningEffort(model);
      await saveUserPreferences(env, userId, model, reasoningEffort, undefined);
      await publishAppHome(env, userId);
      break;
    }

    case "select_repo": {
      if (!channel || !messageTs || !userId) return;
      const repoId = action.selected_option?.value;
      if (repoId) {
        await handleRepoSelection(repoId, channel, messageTs, threadTs, userId, env, traceId);
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
