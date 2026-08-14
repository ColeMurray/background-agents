/**
 * Core types for trigger-based automation configuration and events.
 */

import { z } from "zod";

// ─── Trigger Configuration ───────────────────────────────────────────────────

export const automationTriggerTypeSchema = z.enum([
  "schedule",
  "github_event",
  "linear_event",
  "sentry",
  "webhook",
  "slack_event",
]);

export type AutomationTriggerType = z.infer<typeof automationTriggerTypeSchema>;

const jsonPathFilterSchema = z.object({
  path: z.string(),
  comparison: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "contains", "exists"]),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type JsonPathFilter = z.infer<typeof jsonPathFilterSchema>;

/** Value shape for the `text_match` condition (keyword / substring / regex). */
const textMatchValueSchema = z.object({
  /** Keyword/substring (contains/exact) or regular-expression source (regex). */
  pattern: z.string(),
  /** Case/regex flags; only an allowlisted subset is accepted (see ALLOWED_REGEX_FLAGS). */
  flags: z.string().optional(),
});

export type TextMatchValue = z.infer<typeof textMatchValueSchema>;

const stringArrayConditionValueSchema = z.array(z.string());

const triggerConditionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("branch"),
    operator: z.enum(["glob_match", "exact"]),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("target_branch"),
    operator: z.enum(["glob_match", "exact"]),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("label"),
    operator: z.enum(["any_of", "none_of"]),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("path_glob"),
    operator: z.literal("any_match"),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("actor"),
    operator: z.enum(["include", "exclude"]),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("check_conclusion"),
    operator: z.literal("eq"),
    value: z.string(),
  }),
  z.object({
    type: z.literal("linear_status"),
    operator: z.literal("any_of"),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("sentry_project"),
    operator: z.literal("any_of"),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("sentry_level"),
    operator: z.literal("any_of"),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("jsonpath"),
    operator: z.literal("all_match"),
    value: z.array(jsonPathFilterSchema),
  }),
  z.object({
    type: z.literal("text_match"),
    operator: z.enum(["contains", "exact", "regex"]),
    value: textMatchValueSchema,
  }),
  z.object({
    type: z.literal("slack_channel"),
    operator: z.literal("any_of"),
    value: stringArrayConditionValueSchema,
  }),
  z.object({
    type: z.literal("slack_actor"),
    operator: z.enum(["include", "exclude"]),
    value: stringArrayConditionValueSchema,
  }),
]);

export type TriggerCondition = z.infer<typeof triggerConditionSchema>;

export type ConditionType = TriggerCondition["type"];

export type ConditionConfigMap = {
  [K in ConditionType]: Omit<Extract<TriggerCondition, { type: K }>, "type">;
};

/** Trigger settings stored as JSON in D1. */
export const triggerConfigSchema = z.object({
  conditions: z.array(triggerConditionSchema),
});

export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

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
  /** Provider's created_at (epoch ms) — analytics cohort bucketing. */
  providerCreatedAt?: number;
  /** Provider's updated_at (epoch ms) — the monotonic write guard source. */
  providerUpdatedAt?: number;
  /** Provider's merged_at (epoch ms); only meaningful when merged. */
  mergedAt?: number;
  /** Provider's closed_at (epoch ms); only meaningful when not open. */
  closedAt?: number;
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
  /** Permalink to the triggering message, when Slack returned one. */
  permalink?: string;
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
        providerCreatedAt: z.number().optional(),
        providerUpdatedAt: z.number().optional(),
        mergedAt: z.number().optional(),
        closedAt: z.number().optional(),
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
    permalink: z.string().optional(),
    threadTs: z.string().optional(),
    ts: z.string(),
    actorUserId: z.string(),
    text: z.string(),
  }),
]);

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
