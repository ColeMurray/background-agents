/**
 * Normalize raw GitHub webhook payloads into GitHubAutomationEvent objects.
 */

import type { GitHubAutomationEvent } from "../types";
import { buildGitHubContextBlock } from "./context";
import {
  GITHUB_WEBHOOK_EVENT_CATALOG,
  type CheckSuitePayload,
  type IssueCommentPayload,
  type IssuesPayload,
  type PullRequestPayload,
  type PullRequestReviewCommentPayload,
  type SupportedGitHubPayload,
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

function getRepoOwner(payload: SupportedGitHubPayload): string {
  const repo = getRepo(payload);
  return repo?.owner?.login ?? "";
}

function getRepoName(payload: SupportedGitHubPayload): string {
  const repo = getRepo(payload);
  return repo?.name ?? "";
}

function getActor(payload: SupportedGitHubPayload): string | undefined {
  return payload.sender?.login;
}

function getRepo(payload: SupportedGitHubPayload) {
  return payload.repository;
}

function getPR(payload: PullRequestPayload): PullRequestPayload["pull_request"];
function getPR(
  payload: PullRequestReviewCommentPayload
): PullRequestReviewCommentPayload["pull_request"];
function getPR(payload: PullRequestPayload | PullRequestReviewCommentPayload) {
  return payload.pull_request;
}

function getIssue(payload: IssueCommentPayload | IssuesPayload) {
  return payload.issue;
}

function getComment(payload: IssueCommentPayload | PullRequestReviewCommentPayload) {
  return payload.comment;
}

function getCheckSuite(payload: CheckSuitePayload) {
  return payload.check_suite;
}

function getPRLabels(pr: PullRequestPayload["pull_request"]): string[] | undefined {
  const names = pr.labels?.map((l) => l.name).filter(Boolean);
  return names?.length ? names : undefined;
}

function getIssueLabels(issue: IssuesPayload["issue"]): string[] | undefined {
  const names = issue.labels?.map((l) => l.name).filter(Boolean);
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

  const typedPayload = payload as unknown as SupportedGitHubPayload;

  const eventType = `${githubEventHeader}.${action}`;
  const repoOwner = getRepoOwner(typedPayload);
  const repoName = getRepoName(typedPayload);
  const actor = getActor(typedPayload);

  switch (githubEventHeader) {
    case "pull_request":
      return normalizePullRequest(
        eventType,
        action,
        typedPayload as PullRequestPayload,
        repoOwner,
        repoName,
        actor
      );

    case "issue_comment":
      return normalizeIssueComment(
        eventType,
        typedPayload as IssueCommentPayload,
        repoOwner,
        repoName,
        actor
      );

    case "pull_request_review_comment":
      return normalizeReviewComment(
        eventType,
        typedPayload as PullRequestReviewCommentPayload,
        repoOwner,
        repoName,
        actor
      );

    case "check_suite":
      return normalizeCheckSuite(
        eventType,
        typedPayload as CheckSuitePayload,
        repoOwner,
        repoName,
        actor
      );

    case "issues":
      return normalizeIssue(
        eventType,
        action,
        typedPayload as IssuesPayload,
        repoOwner,
        repoName,
        actor
      );

    default:
      return null;
  }
}

// ─── Per-event normalizers ────────────────────────────────────────────────────

function normalizePullRequest(
  eventType: string,
  action: string,
  payload: PullRequestPayload,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const pr = getPR(payload);
  if (!pr) return null;

  const prNumber = pr.number;
  if (typeof prNumber !== "number" || !Number.isFinite(prNumber)) return null;

  const headSha = pr.head?.sha;
  const branch = pr.head?.ref;
  const labels = getPRLabels(pr);

  const triggerKey = `pr:${prNumber}:${action}:${headSha ?? "unknown"}`;
  const concurrencyKey = `pr:${prNumber}`;

  return {
    source: "github",
    eventType,
    triggerKey,
    concurrencyKey,
    repoOwner,
    repoName,
    branch,
    labels,
    actor,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      prNumber,
      sha: headSha,
      action,
    },
  };
}

function normalizeIssueComment(
  eventType: string,
  payload: IssueCommentPayload,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const comment = getComment(payload);
  const issue = getIssue(payload);
  if (!comment) return null;

  const commentId = comment.id;
  if (typeof commentId !== "number" || !Number.isFinite(commentId)) return null;

  const issueNumber = issue?.number;
  if (typeof issueNumber !== "number" || !Number.isFinite(issueNumber)) return null;

  const triggerKey = `issue_comment:${commentId}`;
  const concurrencyKey = `issue_comment:${commentId}`;

  return {
    source: "github",
    eventType,
    triggerKey,
    concurrencyKey,
    repoOwner,
    repoName,
    actor,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      commentId,
      issueNumber,
    },
  };
}

function normalizeReviewComment(
  eventType: string,
  payload: PullRequestReviewCommentPayload,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const comment = getComment(payload);
  const pr = getPR(payload);
  if (!comment || !pr) return null;

  const commentId = comment.id;
  if (typeof commentId !== "number" || !Number.isFinite(commentId)) return null;

  const prNumber = pr.number;
  if (typeof prNumber !== "number" || !Number.isFinite(prNumber)) return null;

  const branch = pr.head?.ref;
  const triggerKey = `pr_review_comment:${commentId}`;
  const concurrencyKey = `pr:${prNumber}`;

  return {
    source: "github",
    eventType,
    triggerKey,
    concurrencyKey,
    repoOwner,
    repoName,
    branch,
    actor,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      commentId,
      prNumber,
    },
  };
}

function normalizeCheckSuite(
  eventType: string,
  payload: CheckSuitePayload,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const checkSuite = getCheckSuite(payload);
  if (!checkSuite) return null;

  const checkSuiteId = checkSuite.id;
  if (typeof checkSuiteId !== "number" || !Number.isFinite(checkSuiteId)) return null;

  const conclusion = checkSuite.conclusion ?? undefined;
  const headBranch = checkSuite.head_branch ?? undefined;
  const triggerKey = `check_suite:${checkSuiteId}`;
  const concurrencyKey = `check_suite:${checkSuiteId}`;

  return {
    source: "github",
    eventType,
    triggerKey,
    concurrencyKey,
    repoOwner,
    repoName,
    branch: headBranch,
    actor,
    checkConclusion: conclusion,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      checkSuiteId,
      conclusion,
    },
  };
}

function normalizeIssue(
  eventType: string,
  action: string,
  payload: IssuesPayload,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const issue = getIssue(payload);
  if (!issue) return null;

  const issueNumber = issue.number;
  if (typeof issueNumber !== "number" || !Number.isFinite(issueNumber)) return null;

  const labels = getIssueLabels(issue);
  const triggerKey = `issue:${issueNumber}:${action}`;
  const concurrencyKey = `issue:${issueNumber}`;

  return {
    source: "github",
    eventType,
    triggerKey,
    concurrencyKey,
    repoOwner,
    repoName,
    labels,
    actor,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      issueNumber,
      action,
    },
  };
}
