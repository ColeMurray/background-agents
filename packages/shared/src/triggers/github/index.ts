/**
 * GitHub trigger source module.
 */

import type { TriggerSourceDefinition } from "../types";

export type { GitHubAutomationEvent } from "../types";
export { normalizeGitHubEvent } from "./normalizer";
export { buildGitHubContextBlock } from "./context";

export const githubSource: TriggerSourceDefinition = {
  source: "github",
  triggerType: "github_event",
  displayName: "GitHub",
  description: "Trigger on GitHub pull request, issue, or CI events",
  eventTypes: [
    {
      eventType: "pull_request.opened",
      displayName: "PR Opened",
      description: "A pull request was opened",
    },
    {
      eventType: "pull_request.synchronize",
      displayName: "PR Updated",
      description: "New commits pushed to a pull request",
    },
    {
      eventType: "pull_request.closed",
      displayName: "PR Closed",
      description: "A pull request was closed or merged",
    },
    {
      eventType: "issue_comment.created",
      displayName: "Issue Comment",
      description: "A comment was added to an issue or PR",
    },
    {
      eventType: "pull_request_review_comment.created",
      displayName: "Review Comment",
      description: "A review comment was added to a pull request",
    },
    {
      eventType: "check_suite.completed",
      displayName: "Check Suite Completed",
      description: "A CI check suite finished running",
    },
    {
      eventType: "issues.opened",
      displayName: "Issue Opened",
      description: "A new issue was opened",
    },
    {
      eventType: "issues.labeled",
      displayName: "Issue Labeled",
      description: "A label was added to an issue",
    },
  ],
  supportedConditions: ["branch", "label", "path_glob", "actor", "check_conclusion"],
};
