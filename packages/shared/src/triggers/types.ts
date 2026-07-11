/**
 * Core types for the trigger-based automation event system.
 */

import type { AutomationTriggerType } from "../types/automations";
import type { ConditionType } from "./conditions";
import { z } from "zod";

// ─── Event Sources ────────────────────────────────────────────────────────────

export type AutomationEventSource = "github" | "linear" | "sentry" | "webhook" | "slack";

/**
 * Maps AutomationTriggerType → AutomationEventSource.
 * Used by control-plane validation and web UI condition builders.
 */
export const TRIGGER_TYPE_TO_SOURCE: Partial<Record<AutomationTriggerType, AutomationEventSource>> =
  {
    github_event: "github",
    linear_event: "linear",
    sentry: "sentry",
    webhook: "webhook",
    slack_event: "slack",
  };

// ─── Base Event ───────────────────────────────────────────────────────────────

interface BaseAutomationEvent {
  /** Dot-delimited event type (e.g., "pull_request.opened", "issue.created"). */
  eventType: string;

  /** Trigger key for dedup and concurrency (e.g., "pr:42", "sentry_issue:12345"). */
  triggerKey: string;

  /** Concurrency key — the stable prefix of triggerKey for concurrency scoping. */
  concurrencyKey: string;

  /** Human-readable context block prepended to automation instructions. */
  contextBlock: string;

  /** Raw event metadata for logging/debugging. Not used for matching. */
  meta: Record<string, unknown>;
}

// ─── Source-Specific Variants ─────────────────────────────────────────────────

/**
 * Typed pull-request facts carried on pull_request events. Every field beyond
 * the number is optional and reflects only what the webhook payload actually
 * said — consumers fall back to a provider read when a field is absent.
 */
export interface GitHubPullRequestEventFacts {
  number: number;
  /** Raw provider state; merged-vs-closed is disambiguated by `merged`. */
  state?: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  headSha?: string;
  /**
   * True when the head branch lives in a different repository than the base
   * (fork PR). Undefined when the payload lacks repo identity to compare.
   */
  isCrossRepository?: boolean;
  /** Web URL of the pull request (html_url). */
  url?: string;
  /**
   * Stable id of the repository the PR lives in (the base repo) — the
   * canonical PR-record identity used for webhook correlation.
   */
  repositoryExternalId?: string;
  /** Provider's updated_at (epoch ms) — the monotonic write guard source. */
  providerUpdatedAt?: number;
}

export interface GitHubAutomationEvent extends BaseAutomationEvent {
  source: "github";
  repoOwner: string;
  repoName: string;
  /** Pull request head ref when the event is tied to a PR (source branch). */
  branch?: string;
  /** Pull request base ref when the event is tied to a PR (merge target branch). */
  targetBranch?: string;
  labels?: string[];
  actor?: string;
  changedFiles?: string[];
  checkConclusion?: string;
  /** Present only on pull_request events. */
  pullRequest?: GitHubPullRequestEventFacts;
}

export interface LinearAutomationEvent extends BaseAutomationEvent {
  source: "linear";
  repoOwner: string;
  repoName: string;
  actor?: string;
  labels?: string[];
  linearStatus?: string;
}

export interface SentryAutomationEvent extends BaseAutomationEvent {
  source: "sentry";
  automationId: string;
  sentryProject: string;
  sentryLevel: string;
  culpritFile?: string;
}

export interface WebhookAutomationEvent extends BaseAutomationEvent {
  source: "webhook";
  automationId: string;
  body: unknown;
}

export interface SlackAutomationEvent extends BaseAutomationEvent {
  source: "slack";
  channelId: string;
  channelName?: string;
  /** Parent thread ts when the message is a thread reply. */
  threadTs?: string;
  /** The message's own ts (the triggering message). */
  ts: string;
  actorUserId: string;
  /** Message text — bot-mention token stripped and length-capped. */
  text: string;
}

// ─── Discriminated Union ──────────────────────────────────────────────────────

export type AutomationEvent =
  | GitHubAutomationEvent
  | LinearAutomationEvent
  | SentryAutomationEvent
  | WebhookAutomationEvent
  | SlackAutomationEvent;

const baseAutomationEventSchema = {
  eventType: z.string(),
  triggerKey: z.string(),
  concurrencyKey: z.string(),
  contextBlock: z.string(),
  meta: z.record(z.string(), z.unknown()),
};

export const automationEventSchema = z.discriminatedUnion("source", [
  z.object({
    ...baseAutomationEventSchema,
    source: z.literal("github"),
    repoOwner: z.string(),
    repoName: z.string(),
    branch: z.string().optional(),
    targetBranch: z.string().optional(),
    labels: z.array(z.string()).optional(),
    actor: z.string().optional(),
    changedFiles: z.array(z.string()).optional(),
    checkConclusion: z.string().optional(),
    pullRequest: z
      .object({
        number: z.number(),
        state: z.enum(["open", "closed"]).optional(),
        draft: z.boolean().optional(),
        merged: z.boolean().optional(),
        headSha: z.string().optional(),
        isCrossRepository: z.boolean().optional(),
        url: z.string().optional(),
        repositoryExternalId: z.string().optional(),
        providerUpdatedAt: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    ...baseAutomationEventSchema,
    source: z.literal("linear"),
    repoOwner: z.string(),
    repoName: z.string(),
    actor: z.string().optional(),
    labels: z.array(z.string()).optional(),
    linearStatus: z.string().optional(),
  }),
  z.object({
    ...baseAutomationEventSchema,
    source: z.literal("sentry"),
    automationId: z.string(),
    sentryProject: z.string(),
    sentryLevel: z.string(),
    culpritFile: z.string().optional(),
  }),
  z.object({
    ...baseAutomationEventSchema,
    source: z.literal("webhook"),
    automationId: z.string(),
    body: z.unknown(),
  }),
  z.object({
    ...baseAutomationEventSchema,
    source: z.literal("slack"),
    channelId: z.string(),
    channelName: z.string().optional(),
    threadTs: z.string().optional(),
    ts: z.string(),
    actorUserId: z.string(),
    text: z.string(),
  }),
]);

export type ParsedAutomationEvent = z.infer<typeof automationEventSchema>;

// ─── Trigger Source Definition ────────────────────────────────────────────────

export interface TriggerSourceDefinition {
  /** Source identifier — must match a member of AutomationEventSource. */
  source: AutomationEventSource;

  /** The trigger_type value stored in D1. */
  triggerType: AutomationTriggerType;

  /** Human-readable name for the UI. */
  displayName: string;

  /** Short description shown in the trigger type selector. */
  description: string;

  /** Supported event types with UI metadata. */
  eventTypes: Array<{
    eventType: string;
    displayName: string;
    description: string;
  }>;

  /** Whether the UI should expose an event type selector for this trigger source. */
  supportsEventTypes?: boolean;

  /** Optional UI placeholder for the event type selector for this trigger source. */
  eventTypePlaceholder?: string;

  /** Condition types this source supports (keys into ConditionConfigMap). */
  supportedConditions: ConditionType[];
}
