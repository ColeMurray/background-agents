/**
 * Sentry trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export type { SentryAutomationEvent } from "../types";
export { conditions as sentryConditions } from "./conditions";
export { normalizeSentryEvent } from "./normalizer";
export { buildSentryContextBlock } from "./context";
export { verifySentrySignature } from "./signature";

export const sentrySource: TriggerSourceDefinition = {
  source: "sentry",
  triggerType: "sentry",
  displayName: "Sentry",
  description: "Trigger when Sentry detects a new error, regression, or metric alert",
  supportsEventTypes: true,
  eventTypePlaceholder: "Select Sentry event type...",
  eventTypes: [
    {
      eventType: "issue.created",
      displayName: "New error",
      description: "A new error is seen for the first time",
    },
    {
      eventType: "issue.regression",
      displayName: "Error regression",
      description: "A previously resolved error has returned",
    },
    {
      eventType: "metric_alert.critical",
      displayName: "Metric alert (critical)",
      description: "A Sentry metric alert crossed its critical threshold",
    },
  ],
  supportedConditions: ["sentry_project", "sentry_level"],
};
