/**
 * Central registry assembling condition handlers and trigger sources.
 */

import type { ConditionRegistry } from "./conditions";
import type { TriggerSourceDefinition } from "./types";
import { sentrySource, sentryConditions } from "./sentry";
import { webhookSource, webhookConditions } from "./webhook";

// GitHub and Linear condition handlers (stubs for Phase 2c).
// These need to exist so that the ConditionRegistry is complete.
import { matchGlob } from "./glob";
import type { AutomationEvent } from "./types";

/**
 * GitHub + Linear condition handlers defined here (cross-source).
 * Will move to source modules when those ship in Phase 2c.
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
  label: {
    appliesTo: ["github", "linear"] as const,
    validate(c: { value: string[] }) {
      return c.value.length === 0 ? "At least one label required" : null;
    },
    evaluate(c: { operator: string; value: string[] }, event: AutomationEvent) {
      if (event.source !== "github" && event.source !== "linear") return true;
      const labels = event.labels;
      if (!labels?.length) return c.operator === "none_of";
      const hasOverlap = c.value.some((l: string) => labels.includes(l));
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
      return c.operator === "include"
        ? c.value.includes(event.actor)
        : !c.value.includes(event.actor);
    },
  },
  check_conclusion: {
    appliesTo: ["github"] as const,
    validate(c: { value: string }) {
      return ["success", "failure", "neutral", "cancelled", "timed_out"].includes(c.value)
        ? null
        : `Invalid conclusion: ${c.value}`;
    },
    evaluate(c: { value: string }, event: AutomationEvent) {
      if (event.source !== "github") return true;
      return event.checkConclusion === c.value;
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
};

/**
 * All registered trigger sources. The UI reads this for the trigger type selector.
 * Only Sentry and Webhook are active in Phase 2a/2b.
 */
export const triggerSources: TriggerSourceDefinition[] = [sentrySource, webhookSource];
