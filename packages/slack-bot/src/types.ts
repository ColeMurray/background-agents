/**
 * Type definitions for the Slack bot.
 */

import type { ConfidenceLevel } from "@open-inspect/shared/types/repository-catalog";
import type { ControlPlaneFetcher } from "@open-inspect/shared/service-auth";
import type { KeyValueStore } from "@open-inspect/shared/cache-store";
import type { SlackCompletionJob } from "./completion/job";
// targets.ts is a pure leaf (types + policy functions, no I/O), so the types
// barrel can depend on it without a cycle.
import type { SlackSessionTarget } from "./targets";

interface SlackCompletionQueue {
  send(message: SlackCompletionJob, options?: { contentType?: "json" }): Promise<unknown>;
}

/**
 * Cloudflare Worker environment bindings.
 */
export interface Env {
  // KV namespace
  SLACK_KV: KeyValueStore;

  // Service binding to control plane
  CONTROL_PLANE: ControlPlaneFetcher;

  // Durable completion handoff. All Slack completion callbacks enqueue here.
  SLACK_COMPLETION_QUEUE: SlackCompletionQueue;

  // Environment variables
  DEPLOYMENT_NAME: string;
  CONTROL_PLANE_URL: string;
  WEB_APP_URL: string;
  DEFAULT_MODEL: string;
  CLASSIFICATION_MODEL: string;
  APP_NAME?: string;

  // Secrets
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_APP_TOKEN?: string;
  /**
   * Classifier provider credentials. The deployment binds exactly the one
   * `CLASSIFICATION_MODEL` selects, so each is optional on its own and the
   * classifier guards the branch it needs.
   */
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CONTROL_PLANE_API_KEY?: string;
  SERVICE_AUTH_SECRET?: string; // Per-service sig1 signing secret; also verifies CP callbacks
  LOG_LEVEL?: string;
}

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
 * Result of target classification. Unlike the shared repo-only
 * `ClassificationResult` (still used by the Linear bot), the Slack bot
 * classifies to a {@link SlackSessionTarget}: a repository, a saved
 * environment, or no repository.
 */
export interface ClassificationResult {
  target: SlackSessionTarget | null;
  confidence: ConfidenceLevel;
  reasoning: string;
  alternatives?: SlackSessionTarget[];
  needsClarification: boolean;
  source: "routing_rule" | "channel_association" | "llm";
}

export type { SlackSessionTarget } from "./targets";

/**
 * The two payloads Slack posts to this worker. Both are inferred from the zod
 * schema that guards their route, so the schema stays at the trust boundary
 * and the type is reachable from the barrel.
 */
export type { SlackInteractionPayload } from "./interaction-payload";
export type { SlackEventPayload } from "./events/payload";

/**
 * Hands a promise to the runtime to finish after the response is sent.
 * Slack expects an ack within 3 seconds, so every handler that does real work
 * returns immediately and defers it through one of these.
 */
export type BackgroundTaskScheduler = (promise: Promise<void>) => void;

/**
 * Thread-to-session mapping stored in KV for conversation continuity.
 */
export interface ThreadSession {
  sessionId: string;
  /** Session-target id: a repo id, environment id, or the no-repository sentinel. */
  repoId: string;
  /** Session-target display label, including `No repository` for an empty sandbox. */
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
