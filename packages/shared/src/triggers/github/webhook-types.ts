import type { WebhookEventMap } from "@octokit/webhooks-types";

type GitHubWebhookEvent = Extract<keyof WebhookEventMap, string>;

type GitHubEventCatalogEntry<E extends GitHubWebhookEvent = GitHubWebhookEvent> = {
  event: E;
  action: Extract<WebhookEventMap[E], { action: string }>["action"];
  displayName: string;
  description: string;
  shortLabel: string;
};

export const GITHUB_WEBHOOK_EVENT_CATALOG = [
  {
    event: "pull_request",
    action: "opened",
    displayName: "PR Opened",
    description: "A pull request was opened",
    shortLabel: "PR opened",
  },
  {
    event: "pull_request",
    action: "synchronize",
    displayName: "PR Updated",
    description: "New commits pushed to a pull request",
    shortLabel: "PR updated",
  },
  {
    event: "pull_request",
    action: "closed",
    displayName: "PR Closed",
    description: "A pull request was closed or merged",
    shortLabel: "PR closed",
  },
  {
    event: "issue_comment",
    action: "created",
    displayName: "Issue Comment",
    description: "A comment was added to an issue or PR",
    shortLabel: "comment created",
  },
  {
    event: "pull_request_review_comment",
    action: "created",
    displayName: "Review Comment",
    description: "A review comment was added to a pull request",
    shortLabel: "review comment created",
  },
  {
    event: "check_suite",
    action: "completed",
    displayName: "Check Suite Completed",
    description: "A CI check suite finished running",
    shortLabel: "CI completed",
  },
  {
    event: "issues",
    action: "opened",
    displayName: "Issue Opened",
    description: "A new issue was opened",
    shortLabel: "issue opened",
  },
  {
    event: "issues",
    action: "labeled",
    displayName: "Issue Labeled",
    description: "A label was added to an issue",
    shortLabel: "issue labeled",
  },
] as const satisfies readonly GitHubEventCatalogEntry[];

export type SupportedGitHubEventCatalogEntry = (typeof GITHUB_WEBHOOK_EVENT_CATALOG)[number];
export type SupportedGitHubEventName = SupportedGitHubEventCatalogEntry["event"];
export type SupportedGitHubActionForEvent<E extends SupportedGitHubEventName> = Extract<
  SupportedGitHubEventCatalogEntry,
  { event: E }
>["action"];

type PayloadForCatalogEntry<T extends SupportedGitHubEventCatalogEntry> = Extract<
  WebhookEventMap[T["event"]],
  { action: T["action"] }
>;

export type PullRequestPayload = Extract<
  WebhookEventMap["pull_request"],
  { action: SupportedGitHubActionForEvent<"pull_request"> }
>;
export type IssueCommentPayload = Extract<
  WebhookEventMap["issue_comment"],
  { action: SupportedGitHubActionForEvent<"issue_comment"> }
>;
export type PullRequestReviewCommentPayload = Extract<
  WebhookEventMap["pull_request_review_comment"],
  { action: SupportedGitHubActionForEvent<"pull_request_review_comment"> }
>;
export type CheckSuitePayload = Extract<
  WebhookEventMap["check_suite"],
  { action: SupportedGitHubActionForEvent<"check_suite"> }
>;
export type IssuesPayload = Extract<
  WebhookEventMap["issues"],
  { action: SupportedGitHubActionForEvent<"issues"> }
>;

export type SupportedGitHubPayload = PayloadForCatalogEntry<SupportedGitHubEventCatalogEntry>;
