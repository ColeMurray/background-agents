/**
 * Type definitions for the Slack bot.
 */

import type { SlackCompletionJob } from "../completion/job";

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace
  SLACK_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Durable completion handoff. All Slack completion callbacks enqueue here.
  SLACK_COMPLETION_QUEUE: Queue<SlackCompletionJob>;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  CLASSIFICATION_MODEL: string;
  APP_NAME?: string;
  /**
   * Kill switch for Slack channel-message automation triggers. The bot only
   * ingests/forwards channel messages when this is exactly "true". Dark by
   * default — any other value (or unset) disables the feature entirely.
   */
  SLACK_TRIGGERS_ENABLED?: string;

  // Secrets
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APP_TOKEN?: string;
  ANTHROPIC_API_KEY: string;
  CONTROL_PLANE_API_KEY?: string;
  INTERNAL_CALLBACK_SECRET?: string; // For verifying callbacks from control-plane
  LOG_LEVEL?: string;
}

/**
 * Repository configuration for the classifier.
 */
export type {
  RepoConfig,
  RepoMetadata,
  ControlPlaneRepo,
  ControlPlaneReposResponse,
} from "@open-inspect/shared";

/**
 * Thread context for classification.
 */
export interface ThreadContext {
  channelId: string;
  channelName?: string;
  channelDescription?: string;
  threadTs?: string;
  previousMessages?: string[];
}

import type { ConfidenceLevel } from "@open-inspect/shared";
// targets.ts is a pure leaf (types + policy functions, no I/O), so the types
// barrel can depend on it without a cycle.
import type { SlackSessionTarget } from "../targets";

/**
 * Result of target classification. Unlike the shared repo-only
 * `ClassificationResult` (still used by the Linear bot), the Slack bot
 * classifies to a {@link SlackSessionTarget} — a repository or a saved
 * environment — because routing rules can name either.
 */
export interface ClassificationResult {
  target: SlackSessionTarget | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives?: SlackSessionTarget[];
  needsClarification: boolean;
}

export type { ConfidenceLevel, Environment } from "@open-inspect/shared";
export type { SlackSessionTarget } from "../targets";

/**
 * Slack event types.
 */
export interface SlackEvent {
  type: string;
  event: {
    type: string;
    text?: string;
    user?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
  };
  event_id: string;
  event_time: number;
  team_id: string;
}

/**
 * Slack message event.
 */
export interface SlackMessageEvent {
  type: "message";
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
  bot_id?: string;
}

/**
 * Slack app_mention event.
 */
export interface SlackAppMentionEvent {
  type: "app_mention";
  text: string;
  user: string;
  channel: string;
  ts: string;
  thread_ts?: string;
}

export type { SlackInteractionPayload } from "../interaction-payload";

/**
 * Callback context passed with prompts for follow-up notifications.
 */
export type { SlackCallbackContext, CallbackContext } from "@open-inspect/shared";
import type { SlackCallbackContext } from "@open-inspect/shared";

// Keep backward-compatible alias
export type SlackBotCallbackContext = SlackCallbackContext;

/**
 * Thread-to-session mapping stored in KV for conversation continuity.
 */
export interface ThreadSession {
  sessionId: string;
  /** Session-target id: the repo id ("owner/name") or environment id ("env_…"). */
  repoId: string;
  /** Session-target display label: the repo fullName or environment name. */
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  /** Unix timestamp of when the session was created. Used for debugging and observability. */
  createdAt: number;
  /**
   * Slack ts of the last thread message forwarded to the session. Follow-up
   * prompts include the human messages posted after this point so the agent
   * sees discussion that happened between invocations.
   */
  lastPromptTs?: string;
}

/**
 * Completion callback payload from control-plane.
 */
export interface CompletionCallback {
  sessionId: string;
  messageId: string;
  success: boolean;
  error?: string;
  timestamp: number;
  signature: string;
  context: SlackCallbackContext;
}

/**
 * Tool-call callback payload from control-plane.
 */
export interface ToolCallCallback {
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  callId: string;
  timestamp: number;
  signature: string;
  context: SlackCallbackContext;
}

/**
 * Event response from control-plane events API.
 */
export type {
  EventResponse,
  ListEventsResponse,
  ArtifactResponse,
  ListArtifactsResponse,
  ToolCallSummary,
  ArtifactInfo,
  AgentResponse,
  UserPreferences,
} from "@open-inspect/shared";
