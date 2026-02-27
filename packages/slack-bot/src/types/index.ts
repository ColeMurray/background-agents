/**
 * Type definitions for the Slack bot.
 */

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace
  SLACK_KV: KVNamespace;

  // Service binding to control plane
  CONTROL_PLANE: Fetcher;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  CLASSIFICATION_MODEL: string;

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

/**
 * Result of repository classification.
 */
export type { ClassificationResult, ConfidenceLevel } from "@open-inspect/shared";

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
  repoId: string;
  repoFullName: string;
  model: string;
  reasoningEffort?: string;
  /** Unix timestamp of when the session was created. Used for debugging and observability. */
  createdAt: number;
}

/**
 * Completion callback payload from control-plane.
 */
export interface CompletionCallback {
  sessionId: string;
  messageId: string;
  success: boolean;
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
