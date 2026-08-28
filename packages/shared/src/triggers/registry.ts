/**
 * Central registry assembling condition handlers and trigger sources.
 */

import type { ConditionRegistry } from "./conditions";
import type { TriggerSourceDefinition } from "./types";
import { sentrySource, sentryConditions } from "./sentry";
import { webhookSource, webhookConditions } from "./webhook";
import { githubSource, githubConditions } from "./github";
import { slackSource, slackConditions } from "./slack";

// Cross-source and reserved Linear handlers remain here.
import type { AutomationEvent } from "./types";
/** Cross-source and reserved Linear condition handlers. */
const sharedConditions = {
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
  ...githubConditions,
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
