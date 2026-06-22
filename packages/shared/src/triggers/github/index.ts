/**
 * GitHub trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";
import { GITHUB_WEBHOOK_EVENT_CATALOG } from "./webhook-types";

export type { GitHubAutomationEvent } from "../types";
export { normalizeGitHubEvent } from "./normalizer";
export {
  GITHUB_WEBHOOK_EVENT_CATALOG,
  githubBotIssueCommentPayloadSchema,
  githubBotPullRequestOpenedPayloadSchema,
  githubBotReviewCommentPayloadSchema,
  githubBotReviewRequestedPrecheckPayloadSchema,
  githubBotReviewRequestedPayloadSchema,
} from "./webhook-types";
export type {
  GitHubBotIssueCommentPayload,
  GitHubBotPullRequestOpenedPayload,
  GitHubBotReviewCommentPayload,
  GitHubBotReviewRequestedPrecheckPayload,
  GitHubBotReviewRequestedPayload,
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
    "branch",
    "target_branch",
    "label",
    "path_glob",
    "actor",
    "check_conclusion",
  ],
};
