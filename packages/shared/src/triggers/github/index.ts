/**
 * GitHub trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";
import { GITHUB_WEBHOOK_EVENT_CATALOG } from "./webhook-types";

export { githubConditions } from "./conditions";
export { normalizeGitHubEvent } from "./normalizer";
export {
  GITHUB_WEBHOOK_EVENT_CATALOG,
  DEFAULT_GITHUB_CONCLUSION,
  CHECK_SUITE_CONCLUSIONS,
  WORKFLOW_RUN_CONCLUSIONS,
  getGitHubConclusionOptions,
  getGitHubEventConditionTypes,
  isGitHubConditionSupported,
} from "./webhook-types";
export const githubSource: TriggerSourceDefinition = {
  source: "github",
  triggerType: "github_event",
  displayName: "GitHub",
  description: "Trigger on GitHub pull request, issue, or CI events",
  supportsEventTypes: true,
  eventTypePlaceholder: "Select GitHub event type...",
  eventTypes: GITHUB_WEBHOOK_EVENT_CATALOG.map(({ event, action, displayName, description }) => ({
    eventType: `${event}.${action}`,
    displayName,
    description,
  })),
  supportedConditions: [
    ...new Set(
      GITHUB_WEBHOOK_EVENT_CATALOG.flatMap(({ supportedConditions }) => supportedConditions)
    ),
  ],
};
