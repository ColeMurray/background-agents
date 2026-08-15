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

// ─── Automation Events ────────────────────────────────────────────────────────

const baseAutomationEventSchema = {
  /** Dot-delimited event type (e.g., "pull_request.opened", "issue.created"). */
  eventType: z.string().min(1),
  /** Trigger key for dedup and concurrency (e.g., "pr:42", "sentry_issue:12345"). */
  triggerKey: z.string().min(1),
  /** Stable prefix of triggerKey used for concurrency scoping. */
  concurrencyKey: z.string().min(1),
  /** Human-readable context prepended to automation instructions. */
  contextBlock: z.string(),
  /** Raw event metadata for logging/debugging. Not used for matching. */
  meta: z.record(z.string(), z.unknown()),
};

export const githubAutomationEventSchema = z.object({
  ...baseAutomationEventSchema,
  source: z.literal("github"),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  /** Pull request head ref when the event is tied to a PR. */
  branch: z.string().optional(),
  /** Pull request base ref when the event is tied to a PR. */
  targetBranch: z.string().optional(),
  labels: z.array(z.string()).optional(),
  actor: z.string().optional(),
  changedFiles: z.array(z.string()).optional(),
  checkConclusion: z.string().optional(),
  /** Present only on pull_request events. */
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
});

export const linearAutomationEventSchema = z.object({
  ...baseAutomationEventSchema,
  source: z.literal("linear"),
  repoOwner: z.string().min(1),
  repoName: z.string().min(1),
  actor: z.string().optional(),
  labels: z.array(z.string()).optional(),
  linearStatus: z.string().optional(),
});

export const sentryAutomationEventSchema = z.object({
  ...baseAutomationEventSchema,
  source: z.literal("sentry"),
  automationId: z.string().min(1),
  /** Metric alerts do not identify a single project. */
  sentryProject: z.string().min(1).optional(),
  sentryLevel: z.string().min(1),
  culpritFile: z.string().optional(),
});

export const webhookAutomationEventSchema = z.object({
  ...baseAutomationEventSchema,
  source: z.literal("webhook"),
  automationId: z.string().min(1),
  body: z.unknown(),
});

export const slackAutomationEventSchema = z.object({
  ...baseAutomationEventSchema,
  source: z.literal("slack"),
  channelId: z.string().min(1),
  channelName: z.string().optional(),
  /** Permalink to the triggering message, when Slack returned one. */
  permalink: z.string().optional(),
  /** Parent thread ts when the message is a thread reply. */
  threadTs: z.string().optional(),
  /** The triggering message's own ts. */
  ts: z.string().min(1),
  actorUserId: z.string().min(1),
  /** Bot-mention token stripped and length-capped. */
  text: z.string(),
});

export const automationEventSchema = z.discriminatedUnion("source", [
  githubAutomationEventSchema,
  linearAutomationEventSchema,
  sentryAutomationEventSchema,
  webhookAutomationEventSchema,
  slackAutomationEventSchema,
]);

export type AutomationEvent = z.infer<typeof automationEventSchema>;
export type AutomationEventSource = AutomationEvent["source"];
export type GitHubAutomationEvent = z.infer<typeof githubAutomationEventSchema>;
export type GitHubPullRequestEventFacts = NonNullable<GitHubAutomationEvent["pullRequest"]>;
export type LinearAutomationEvent = z.infer<typeof linearAutomationEventSchema>;
export type SentryAutomationEvent = z.infer<typeof sentryAutomationEventSchema>;
export type WebhookAutomationEvent = z.infer<typeof webhookAutomationEventSchema>;
export type SlackAutomationEvent = z.infer<typeof slackAutomationEventSchema>;

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
