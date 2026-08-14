/**
 * Central registry assembling condition handlers and trigger sources.
 */

import type { ConditionRegistry } from "./conditions";
import type { TriggerSourceDefinition } from "./types";
import { sentrySource, sentryConditions } from "./sentry";
import { webhookSource, webhookConditions } from "./webhook";
import { githubSource } from "./github";
import { slackSource, slackConditions } from "./slack";

// GitHub condition handlers and the reserved Linear handlers live here so the
// ConditionRegistry remains complete across sources.
import { matchGlob } from "./glob";
import type { AutomationEvent } from "./types";

export const DEFAULT_GITHUB_CONCLUSION = "success" as const;

export const GITHUB_CONCLUSIONS = [
  DEFAULT_GITHUB_CONCLUSION,
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "skipped",
  "stale",
  "startup_failure",
] as const;

const githubConclusionSet: ReadonlySet<string> = new Set(GITHUB_CONCLUSIONS);

function validateGitHubConclusion(condition: { value: string }): string | null {
  return githubConclusionSet.has(condition.value) ? null : `Invalid conclusion: ${condition.value}`;
}

/**
 * GitHub and Linear condition handlers defined here (cross-source).
 */
const sharedConditions = {
  branch: {
    appliesTo: ["github"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one branch pattern required" : null;
    },
    evaluate(c: { operator: string; value: string[] }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      if (!event.branch) return false;
      if (c.operator === "exact") return c.value.includes(event.branch);
      return c.value.some((pattern: string) => matchGlob(pattern, event.branch!));
    },
  },
  target_branch: {
    appliesTo: ["github"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one target branch pattern required" : null;
    },
    evaluate(c: { operator: string; value: string[] }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      if (!event.targetBranch) return false;
      if (c.operator === "exact") return c.value.includes(event.targetBranch);
      return c.value.some((pattern: string) => matchGlob(pattern, event.targetBranch!));
    },
  },
  label: {
    appliesTo: ["github", "linear"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one label required" : null;
    },
    evaluate(c: { operator: string; value: string[] }, event: AutomationEvent) {
      if (event.source !== "github" && event.source !== "linear") return true;
      const labels = event.labels;
      if (!labels?.length) return c.operator === "none_of";
      const lowerLabels = labels.map((l) => l.toLowerCase());
      const hasOverlap = c.value.some((l: string) => lowerLabels.includes(l.toLowerCase()));
      return c.operator === "any_of" ? hasOverlap : !hasOverlap;
    },
  },
  path_glob: {
    appliesTo: ["github"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one path pattern required" : null;
    },
    evaluate(c: { value: string[] }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      if (!event.changedFiles?.length) return false;
      return c.value.some((glob: string) =>
        event.changedFiles!.some((file: string) => matchGlob(glob, file))
      );
    },
  },
  actor: {
    appliesTo: ["github", "linear"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one actor required" : null;
    },
    evaluate(c: { operator: string; value: string[] }, event: AutomationEvent) {
      if (event.source !== "github" && event.source !== "linear") return true;
      if (!event.actor) return false;
      const lowerActor = event.actor.toLowerCase();
      return c.operator === "include"
        ? c.value.some((v: string) => v.toLowerCase() === lowerActor)
        : c.value.every((v: string) => v.toLowerCase() !== lowerActor);
    },
  },
  conclusion: {
    appliesTo: ["github"] as const,
    validate: validateGitHubConclusion,
    evaluate(c: { value: string }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      return event.conclusion === c.value;
    },
  },
  check_conclusion: {
    appliesTo: ["github"] as const,
    validate: validateGitHubConclusion,
    evaluate(c: { value: string }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      return event.checkConclusion === c.value;
    },
  },
  workflow_name: {
    appliesTo: ["github"] as const,
    validate(c: { value: string }) {
      return c.value.trim().length === 0 ? "Workflow name is required" : null;
    },
    evaluate(c: { value: string }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      return event.workflowName === c.value;
    },
  },
  linear_status: {
    appliesTo: ["linear"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one status required" : null;
    },
    evaluate(c: { value: string[] }, event: AutomationEvent) {
      if (event.source !== "linear") return true;
      return event.linearStatus ? c.value.includes(event.linearStatus) : false;
    },
  },
} satisfies Partial<ConditionRegistry>;

/**
 * Assembled condition registry — every key in ConditionConfigMap has a handler.
 */
export const conditionRegistry: ConditionRegistry = {
  ...sharedConditions,
  ...sentryConditions,
  ...webhookConditions,
  ...slackConditions,
};

/**
 * All registered trigger sources. The UI reads this for the trigger type selector.
 */
export const triggerSources: TriggerSourceDefinition[] = [
  sentrySource,
  webhookSource,
  githubSource,
  slackSource,
];
