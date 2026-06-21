/**
 * Normalize raw GitHub webhook payloads into GitHubAutomationEvent objects.
 */

import type { GitHubAutomationEvent } from "../types";
import {
  buildCheckSuiteContextBlock,
  buildIssueCommentContextBlock,
  buildIssueContextBlock,
  buildPullRequestContextBlock,
  buildReviewCommentContextBlock,
} from "./context";
import {
  GITHUB_WEBHOOK_EVENT_CATALOG,
  checkSuiteEventSchema,
  issueCommentEventSchema,
  issuesEventSchema,
  pullRequestEventSchema,
  pullRequestReviewCommentEventSchema,
  type CheckSuitePayload,
  type GitHubEventBase,
  type IssueCommentPayload,
  type IssuesPayload,
  type PullRequestPayload,
  type PullRequestReviewCommentPayload,
} from "./webhook-types";

// ─── Supported event type map ─────────────────────────────────────────────────

const SUPPORTED_EVENTS: Record<string, Set<string>> = GITHUB_WEBHOOK_EVENT_CATALOG.reduce(
  (supportedEvents, { event, action }) => {
    if (!supportedEvents[event]) {
      supportedEvents[event] = new Set<string>();
    }
    supportedEvents[event].add(action);
    return supportedEvents;
  },
  {} as Record<string, Set<string>>
);

// ─── Payload accessors ────────────────────────────────────────────────────────

function getRepoOwner(payload: GitHubEventBase): string {
  return payload.repository?.owner?.login ?? "";
}

function getRepoName(payload: GitHubEventBase): string {
  return payload.repository?.name ?? "";
}

function getActor(payload: GitHubEventBase): string | undefined {
  return payload.sender?.login;
}

function getPRLabels(pr: PullRequestPayload["pull_request"]): string[] | undefined {
  const names = pr.labels?.map((l) => l.name).filter((name): name is string => Boolean(name));
  return names?.length ? names : undefined;
}

function getIssueLabels(issue: IssuesPayload["issue"]): string[] | undefined {
  const names = issue.labels?.map((l) => l.name).filter((name): name is string => Boolean(name));
  return names?.length ? names : undefined;
}

// ─── Main normalizer ──────────────────────────────────────────────────────────

export function normalizeGitHubEvent(
  githubEventHeader: string,
  payload: Record<string, unknown>
): GitHubAutomationEvent | null {
  const action = payload.action;

  const supportedActions = SUPPORTED_EVENTS[githubEventHeader];
  if (!supportedActions) return null;
  if (typeof action !== "string" || !supportedActions.has(action)) return null;

  const eventType = `${githubEventHeader}.${action}`;

  // Each branch validates the raw payload against its event schema; a malformed
  // payload (missing/ill-typed identifiers) fails the parse and normalizes to null.
  switch (githubEventHeader) {
    case "pull_request": {
      const parsed = pullRequestEventSchema.safeParse(payload);
      if (!parsed.success) return null;
      return normalizePullRequest(eventType, action, parsed.data);
    }

    case "issue_comment": {
      const parsed = issueCommentEventSchema.safeParse(payload);
      if (!parsed.success) return null;
      return normalizeIssueComment(eventType, parsed.data);
    }

    case "pull_request_review_comment": {
      const parsed = pullRequestReviewCommentEventSchema.safeParse(payload);
      if (!parsed.success) return null;
      return normalizeReviewComment(eventType, parsed.data);
    }

    case "check_suite": {
      const parsed = checkSuiteEventSchema.safeParse(payload);
      if (!parsed.success) return null;
      return normalizeCheckSuite(eventType, parsed.data);
    }

    case "issues": {
      const parsed = issuesEventSchema.safeParse(payload);
      if (!parsed.success) return null;
      return normalizeIssue(eventType, action, parsed.data);
    }

    default:
      return null;
  }
}

// ─── Per-event normalizers ────────────────────────────────────────────────────

function normalizePullRequest(
  eventType: string,
  action: string,
  payload: PullRequestPayload
): GitHubAutomationEvent {
  const pr = payload.pull_request;
  const headSha = pr.head?.sha;
  const branch = pr.head?.ref;
  const targetBranch = pr.base?.ref;

  return {
    source: "github",
    eventType,
    triggerKey: `pr:${pr.number}:${action}:${headSha ?? "unknown"}`,
    concurrencyKey: `pr:${pr.number}`,
    repoOwner: getRepoOwner(payload),
    repoName: getRepoName(payload),
    branch,
    targetBranch,
    labels: getPRLabels(pr),
    actor: getActor(payload),
    contextBlock: buildPullRequestContextBlock(eventType, payload),
    meta: {
      prNumber: pr.number,
      sha: headSha,
      action,
      targetBranch,
    },
  };
}

function normalizeIssueComment(
  eventType: string,
  payload: IssueCommentPayload
): GitHubAutomationEvent {
  const commentId = payload.comment.id;

  return {
    source: "github",
    eventType,
    triggerKey: `issue_comment:${commentId}`,
    concurrencyKey: `issue_comment:${commentId}`,
    repoOwner: getRepoOwner(payload),
    repoName: getRepoName(payload),
    actor: getActor(payload),
    contextBlock: buildIssueCommentContextBlock(payload),
    meta: {
      commentId,
      issueNumber: payload.issue.number,
    },
  };
}

function normalizeReviewComment(
  eventType: string,
  payload: PullRequestReviewCommentPayload
): GitHubAutomationEvent {
  const pr = payload.pull_request;
  const commentId = payload.comment.id;
  const targetBranch = pr.base?.ref;

  return {
    source: "github",
    eventType,
    triggerKey: `pr_review_comment:${commentId}`,
    concurrencyKey: `pr:${pr.number}`,
    repoOwner: getRepoOwner(payload),
    repoName: getRepoName(payload),
    branch: pr.head?.ref,
    targetBranch,
    actor: getActor(payload),
    contextBlock: buildReviewCommentContextBlock(payload),
    meta: {
      commentId,
      prNumber: pr.number,
      targetBranch,
    },
  };
}

function normalizeCheckSuite(eventType: string, payload: CheckSuitePayload): GitHubAutomationEvent {
  const checkSuite = payload.check_suite;
  const conclusion = checkSuite.conclusion ?? undefined;

  return {
    source: "github",
    eventType,
    triggerKey: `check_suite:${checkSuite.id}`,
    concurrencyKey: `check_suite:${checkSuite.id}`,
    repoOwner: getRepoOwner(payload),
    repoName: getRepoName(payload),
    branch: checkSuite.head_branch ?? undefined,
    actor: getActor(payload),
    checkConclusion: conclusion,
    contextBlock: buildCheckSuiteContextBlock(payload),
    meta: {
      checkSuiteId: checkSuite.id,
      conclusion,
    },
  };
}

function normalizeIssue(
  eventType: string,
  action: string,
  payload: IssuesPayload
): GitHubAutomationEvent {
  const issue = payload.issue;

  return {
    source: "github",
    eventType,
    triggerKey: `issue:${issue.number}:${action}`,
    concurrencyKey: `issue:${issue.number}`,
    repoOwner: getRepoOwner(payload),
    repoName: getRepoName(payload),
    labels: getIssueLabels(issue),
    actor: getActor(payload),
    contextBlock: buildIssueContextBlock(eventType, payload),
    meta: {
      issueNumber: issue.number,
      action,
    },
  };
}
