/**
 * GitHub trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";
import { GITHUB_WEBHOOK_EVENT_CATALOG } from "./webhook-types";

export type { GitHubAutomationEvent } from "../types";
export { normalizeGitHubEvent } from "./normalizer";
export { buildGitHubContextBlock } from "./context";
export { GITHUB_WEBHOOK_EVENT_CATALOG } from "./webhook-types";

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
  supportedConditions: ["branch", "label", "path_glob", "actor", "check_conclusion"],
};
