/**
 * Webhook trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export type { WebhookAutomationEvent } from "../types";
export { conditions as webhookConditions } from "./conditions";
export { normalizeWebhookEvent, resolveJsonPath, evaluateJsonPathFilter } from "./normalizer";
export { buildWebhookContextBlock } from "./context";

export const webhookSource: TriggerSourceDefinition = {
  source: "webhook",
  triggerType: "webhook",
  displayName: "Inbound Webhook",
  description: "Trigger via HTTP POST from any external system",
  supportsEventTypes: false,
  eventTypes: [
    {
      eventType: "webhook.received",
      displayName: "Webhook received",
      description: "Any HTTP POST to this automation's endpoint",
    },
  ],
  supportedConditions: ["jsonpath"],
};
