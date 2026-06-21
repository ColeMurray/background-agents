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
  const eventType = `${githubEventHeader}.${action}`;

  switch (githubEventHeader) {
    case "pull_request":
      if (!isPullRequestPayload(payload)) return null;
      return normalizePullRequest(
        eventType,
        action,
        payload,
        getRepoOwner(payload),
        getRepoName(payload),
        getActor(payload)
      );

    case "issue_comment":
      if (!isIssueCommentPayload(payload)) return null;
      return normalizeIssueComment(
        eventType,
        payload,
        getRepoOwner(payload),
        getRepoName(payload),
        getActor(payload)
      );

    case "pull_request_review_comment":
      if (!isReviewCommentPayload(payload)) return null;
      return normalizeReviewComment(
        eventType,
        payload,
        getRepoOwner(payload),
        getRepoName(payload),
        getActor(payload)
      );

    case "check_suite":
      if (!isCheckSuitePayload(payload)) return null;
      return normalizeCheckSuite(
        eventType,
        payload,
        getRepoOwner(payload),
        getRepoName(payload),
        getActor(payload)
      );

    case "issues":
      if (!isIssuesPayload(payload)) return null;
      return normalizeIssue(
        eventType,
        action,
        payload,
        getRepoOwner(payload),
        getRepoName(payload),
        getActor(payload)
      );

    default:
      return null;
  }
}

function isPullRequestPayload(payload: unknown): payload is PullRequestPayload {
  if (!isRecord(payload)) return false;
  if (!hasValidRepository(payload) || !hasValidSender(payload)) return false;
  if (!isRecord(payload.pull_request)) return false;
  return hasValidPullRequest(payload.pull_request);
}

function isIssueCommentPayload(payload: unknown): payload is IssueCommentPayload {
  if (!isRecord(payload)) return false;
  if (!hasValidRepository(payload) || !hasValidSender(payload)) return false;
  if (!isRecord(payload.issue) || !isRecord(payload.comment)) return false;
  return hasFiniteNumber(payload.issue.number) && hasFiniteNumber(payload.comment.id);
}

function isReviewCommentPayload(payload: unknown): payload is PullRequestReviewCommentPayload {
  if (!isRecord(payload)) return false;
  if (!hasValidRepository(payload) || !hasValidSender(payload)) return false;
  if (!isRecord(payload.pull_request) || !isRecord(payload.comment)) return false;
  if (!hasFiniteNumber(payload.comment.id)) return false;
  if (!isOptionalString(payload.comment.body)) return false;
  if (!isOptionalString(payload.comment.path)) return false;
  if (!isOptionalString(payload.comment.diff_hunk)) return false;
  return hasValidPullRequest(payload.pull_request);
}

function isCheckSuitePayload(payload: unknown): payload is CheckSuitePayload {
  if (!isRecord(payload)) return false;
  if (!hasValidRepository(payload) || !hasValidSender(payload)) return false;
  if (!isRecord(payload.check_suite)) return false;
  if (!hasFiniteNumber(payload.check_suite.id)) return false;
  if (!isOptionalString(payload.check_suite.conclusion)) return false;
  if (!isOptionalString(payload.check_suite.head_branch)) return false;
  if (!isOptionalString(payload.check_suite.head_sha)) return false;
  const pullRequests = payload.check_suite.pull_requests;
  return (
    pullRequests === undefined ||
    (Array.isArray(pullRequests) &&
      pullRequests.every(
        (pullRequest) => isRecord(pullRequest) && hasFiniteNumber(pullRequest.number)
      ))
  );
}

function isIssuesPayload(payload: unknown): payload is IssuesPayload {
  if (!isRecord(payload)) return false;
  if (!hasValidRepository(payload) || !hasValidSender(payload)) return false;
  if (!isRecord(payload.issue)) return false;
  if (!hasFiniteNumber(payload.issue.number)) return false;
  if (!isOptionalString(payload.issue.title)) return false;
  if (!isOptionalString(payload.issue.body)) return false;
  return hasValidLabels(payload.issue.labels);
}

function hasValidPullRequest(pr: Record<string, unknown>): boolean {
  if (!hasFiniteNumber(pr.number)) return false;
  if (!isOptionalString(pr.title)) return false;
  if (!isOptionalString(pr.body)) return false;
  if (!isOptionalBoolean(pr.merged)) return false;
  if (!hasValidLabels(pr.labels)) return false;
  if (
    pr.head !== undefined &&
    (!isRecord(pr.head) || !isOptionalString(pr.head.ref) || !isOptionalString(pr.head.sha))
  ) {
    return false;
  }
  if (pr.base !== undefined && (!isRecord(pr.base) || !isOptionalString(pr.base.ref))) {
    return false;
  }
  return true;
}

function hasValidRepository(payload: Record<string, unknown>): boolean {
  if (payload.repository === undefined) return true;
  if (!isRecord(payload.repository)) return false;
  if (!isOptionalString(payload.repository.name)) return false;
  if (payload.repository.owner === undefined) return true;
  return isRecord(payload.repository.owner) && isOptionalString(payload.repository.owner.login);
}

function hasValidSender(payload: Record<string, unknown>): boolean {
  if (payload.sender === undefined) return true;
  return isRecord(payload.sender) && isOptionalString(payload.sender.login);
}

function hasValidLabels(labels: unknown): boolean {
  return (
    labels === undefined ||
    (Array.isArray(labels) &&
      labels.every(
        (label) => isRecord(label) && (label.name === undefined || typeof label.name === "string")
      ))
  );
}

function hasFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
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
  const targetBranch = pr.base?.ref;
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
    targetBranch,
    labels,
    actor,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      prNumber,
      sha: headSha,
      action,
      targetBranch,
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
  const targetBranch = pr.base?.ref;
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
    targetBranch,
    actor,
    contextBlock: buildGitHubContextBlock(eventType, payload),
    meta: {
      commentId,
      prNumber,
      targetBranch,
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
