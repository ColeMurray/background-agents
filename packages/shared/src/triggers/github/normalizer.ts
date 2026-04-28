/**
 * Normalize raw GitHub webhook payloads into GitHubAutomationEvent objects.
 */

import type { GitHubAutomationEvent } from "../types";
import { buildGitHubContextBlock } from "./context";

// ─── Supported event type map ─────────────────────────────────────────────────

const SUPPORTED_EVENTS: Record<string, Set<string>> = {
  pull_request: new Set(["opened", "synchronize", "closed"]),
  issue_comment: new Set(["created"]),
  pull_request_review_comment: new Set(["created"]),
  check_suite: new Set(["completed"]),
  issues: new Set(["opened", "labeled"]),
};

// ─── Payload accessors ────────────────────────────────────────────────────────

function getRepo(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return payload.repository as Record<string, unknown> | undefined;
}

function getRepoOwner(payload: Record<string, unknown>): string {
  const repo = getRepo(payload);
  const owner = repo?.owner as Record<string, unknown> | undefined;
  return (owner?.login as string | undefined) ?? "";
}

function getRepoName(payload: Record<string, unknown>): string {
  const repo = getRepo(payload);
  return (repo?.name as string | undefined) ?? "";
}

function getActor(payload: Record<string, unknown>): string | undefined {
  const sender = payload.sender as Record<string, unknown> | undefined;
  return sender?.login as string | undefined;
}

function getPR(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return payload.pull_request as Record<string, unknown> | undefined;
}

function getIssue(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return payload.issue as Record<string, unknown> | undefined;
}

function getComment(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return payload.comment as Record<string, unknown> | undefined;
}

function getCheckSuite(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  return payload.check_suite as Record<string, unknown> | undefined;
}

function getPRLabels(pr: Record<string, unknown>): string[] | undefined {
  const labels = pr.labels as Array<Record<string, unknown>> | undefined;
  const names = labels?.map((l) => l.name as string).filter(Boolean);
  return names?.length ? names : undefined;
}

function getIssueLabels(issue: Record<string, unknown>): string[] | undefined {
  const labels = issue.labels as Array<Record<string, unknown>> | undefined;
  const names = labels?.map((l) => l.name as string).filter(Boolean);
  return names?.length ? names : undefined;
}

// ─── Main normalizer ──────────────────────────────────────────────────────────

export function normalizeGitHubEvent(
  githubEventHeader: string,
  payload: Record<string, unknown>
): GitHubAutomationEvent | null {
  const action = payload.action as string | undefined;

  const supportedActions = SUPPORTED_EVENTS[githubEventHeader];
  if (!supportedActions) return null;
  if (!action || !supportedActions.has(action)) return null;

  const eventType = `${githubEventHeader}.${action}`;
  const repoOwner = getRepoOwner(payload);
  const repoName = getRepoName(payload);
  const actor = getActor(payload);

  switch (githubEventHeader) {
    case "pull_request":
      return normalizePullRequest(eventType, action, payload, repoOwner, repoName, actor);

    case "issue_comment":
      return normalizeIssueComment(eventType, payload, repoOwner, repoName, actor);

    case "pull_request_review_comment":
      return normalizeReviewComment(eventType, payload, repoOwner, repoName, actor);

    case "check_suite":
      return normalizeCheckSuite(eventType, payload, repoOwner, repoName, actor);

    case "issues":
      return normalizeIssue(eventType, action, payload, repoOwner, repoName, actor);

    default:
      return null;
  }
}

// ─── Per-event normalizers ────────────────────────────────────────────────────

function normalizePullRequest(
  eventType: string,
  action: string,
  payload: Record<string, unknown>,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const pr = getPR(payload);
  if (!pr) return null;

  const prNumber = pr.number as number;
  const headSha = (pr.head as Record<string, unknown> | undefined)?.sha as string | undefined;
  const branch = (pr.head as Record<string, unknown> | undefined)?.ref as string | undefined;
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
  payload: Record<string, unknown>,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const comment = getComment(payload);
  const issue = getIssue(payload);
  if (!comment) return null;

  const commentId = comment.id as number;
  const issueNumber = issue?.number as number | undefined;
  const triggerKey = `issue_comment:${commentId}`;
  const concurrencyKey = `issue:${issueNumber ?? "unknown"}`;

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
  payload: Record<string, unknown>,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const comment = getComment(payload);
  const pr = getPR(payload);
  if (!comment) return null;

  const commentId = comment.id as number;
  const prNumber = pr?.number as number | undefined;
  const branch = (pr?.head as Record<string, unknown> | undefined)?.ref as string | undefined;
  const triggerKey = `pr_review_comment:${commentId}`;
  const concurrencyKey = `pr:${prNumber ?? "unknown"}`;

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
  payload: Record<string, unknown>,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const checkSuite = getCheckSuite(payload);
  if (!checkSuite) return null;

  const checkSuiteId = checkSuite.id as number;
  const conclusion = checkSuite.conclusion as string | undefined;
  const headBranch = checkSuite.head_branch as string | undefined;
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
  payload: Record<string, unknown>,
  repoOwner: string,
  repoName: string,
  actor: string | undefined
): GitHubAutomationEvent | null {
  const issue = getIssue(payload);
  if (!issue) return null;

  const issueNumber = issue.number as number;
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
