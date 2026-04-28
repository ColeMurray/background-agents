/**
 * Build context blocks for GitHub automation events.
 */

const BODY_PREVIEW_MAX = 500;
const GITHUB_EVENT_PREAMBLE = "This automation was triggered by a GitHub event.";

export function buildGitHubContextBlock(
  eventType: string,
  payload: Record<string, unknown>
): string {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const repoFullName = repo
    ? `${(repo.owner as Record<string, unknown>)?.login}/${repo.name}`
    : "unknown";

  if (eventType.startsWith("pull_request.")) {
    return buildPullRequestContext(eventType, payload, repoFullName);
  }

  if (eventType === "issue_comment.created") {
    return buildIssueCommentContext(payload, repoFullName);
  }

  if (eventType === "pull_request_review_comment.created") {
    return buildReviewCommentContext(payload, repoFullName);
  }

  if (eventType === "check_suite.completed") {
    return buildCheckSuiteContext(payload, repoFullName);
  }

  if (eventType.startsWith("issues.")) {
    return buildIssueContext(eventType, payload, repoFullName);
  }

  return `${GITHUB_EVENT_PREAMBLE}\n\nEvent: ${eventType}\nRepository: ${repoFullName}`;
}

function buildPullRequestContext(
  eventType: string,
  payload: Record<string, unknown>,
  repoFullName: string
): string {
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) {
    return `${GITHUB_EVENT_PREAMBLE}\n\nEvent: ${eventType}\nRepository: ${repoFullName}`;
  }

  const prNumber = pr.number;
  const title = pr.title as string | undefined;
  const author = (pr.user as Record<string, unknown> | undefined)?.login;
  const headRef = (pr.head as Record<string, unknown> | undefined)?.ref;
  const baseRef = (pr.base as Record<string, unknown> | undefined)?.ref;
  const rawLabels = pr.labels as Array<Record<string, unknown>> | undefined;
  const labels = rawLabels?.map((l) => l.name as string).filter(Boolean) ?? [];
  const body = pr.body as string | undefined;
  const bodyPreview = body ? body.slice(0, BODY_PREVIEW_MAX) : undefined;
  const merged = pr.merged as boolean | undefined;

  const action = eventType.split(".")[1];

  const lines: string[] = [
    GITHUB_EVENT_PREAMBLE,
    "",
    `Event: ${eventType}`,
    `Repository: ${repoFullName}`,
    `PR #${prNumber}: ${title ?? "(no title)"}`,
    `Author: ${author ?? "unknown"}`,
    `Branch: ${headRef ?? "unknown"} → ${baseRef ?? "unknown"}`,
  ];

  if (action === "closed" && merged) {
    lines.push("Status: Merged");
  } else if (action === "closed") {
    lines.push("Status: Closed (not merged)");
  }

  if (labels.length > 0) {
    lines.push(`Labels: ${labels.join(", ")}`);
  }

  if (bodyPreview) {
    lines.push("");
    lines.push("Description:");
    lines.push(bodyPreview);
    if (body && body.length > BODY_PREVIEW_MAX) {
      lines.push("(truncated)");
    }
  }

  return lines.join("\n");
}

function buildIssueCommentContext(payload: Record<string, unknown>, repoFullName: string): string {
  const comment = payload.comment as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;

  const commenter = (comment?.user as Record<string, unknown> | undefined)?.login;
  const commentBody = comment?.body as string | undefined;
  const bodyPreview = commentBody ? commentBody.slice(0, BODY_PREVIEW_MAX) : undefined;
  const issueNumber = issue?.number;
  const issueTitle = issue?.title as string | undefined;

  const lines: string[] = [
    GITHUB_EVENT_PREAMBLE,
    "",
    "Event: issue_comment.created",
    `Repository: ${repoFullName}`,
    `Issue #${issueNumber}: ${issueTitle ?? "(no title)"}`,
    `Commenter: ${commenter ?? "unknown"}`,
  ];

  if (bodyPreview) {
    lines.push("");
    lines.push("Comment:");
    lines.push(bodyPreview);
    if (commentBody && commentBody.length > BODY_PREVIEW_MAX) {
      lines.push("(truncated)");
    }
  }

  return lines.join("\n");
}

function buildReviewCommentContext(payload: Record<string, unknown>, repoFullName: string): string {
  const comment = payload.comment as Record<string, unknown> | undefined;
  const pr = payload.pull_request as Record<string, unknown> | undefined;

  const commenter = (comment?.user as Record<string, unknown> | undefined)?.login;
  const commentBody = comment?.body as string | undefined;
  const bodyPreview = commentBody ? commentBody.slice(0, BODY_PREVIEW_MAX) : undefined;
  const prNumber = pr?.number;
  const prTitle = pr?.title as string | undefined;
  const diffHunk = comment?.diff_hunk as string | undefined;
  const path = comment?.path as string | undefined;

  const lines: string[] = [
    GITHUB_EVENT_PREAMBLE,
    "",
    "Event: pull_request_review_comment.created",
    `Repository: ${repoFullName}`,
    `PR #${prNumber}: ${prTitle ?? "(no title)"}`,
    `Reviewer: ${commenter ?? "unknown"}`,
  ];

  if (path) {
    lines.push(`File: ${path}`);
  }

  if (bodyPreview) {
    lines.push("");
    lines.push("Comment:");
    lines.push(bodyPreview);
    if (commentBody && commentBody.length > BODY_PREVIEW_MAX) {
      lines.push("(truncated)");
    }
  }

  if (diffHunk) {
    lines.push("");
    lines.push("Diff context:");
    lines.push(diffHunk);
  }

  return lines.join("\n");
}

function buildCheckSuiteContext(payload: Record<string, unknown>, repoFullName: string): string {
  const checkSuite = payload.check_suite as Record<string, unknown> | undefined;

  const conclusion = checkSuite?.conclusion as string | undefined;
  const headBranch = checkSuite?.head_branch as string | undefined;
  const headSha = checkSuite?.head_sha as string | undefined;
  const pullRequests = checkSuite?.pull_requests as Array<Record<string, unknown>> | undefined;
  const prNumbers = pullRequests?.map((pr) => `#${pr.number}`).join(", ");

  const lines: string[] = [
    GITHUB_EVENT_PREAMBLE,
    "",
    "Event: check_suite.completed",
    `Repository: ${repoFullName}`,
    `Conclusion: ${conclusion ?? "unknown"}`,
  ];

  if (headBranch) {
    lines.push(`Branch: ${headBranch}`);
  }

  if (headSha) {
    lines.push(`Commit: ${headSha.slice(0, 7)}`);
  }

  if (prNumbers) {
    lines.push(`Pull Requests: ${prNumbers}`);
  }

  return lines.join("\n");
}

function buildIssueContext(
  eventType: string,
  payload: Record<string, unknown>,
  repoFullName: string
): string {
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (!issue) {
    return `${GITHUB_EVENT_PREAMBLE}\n\nEvent: ${eventType}\nRepository: ${repoFullName}`;
  }

  const issueNumber = issue.number;
  const title = issue.title as string | undefined;
  const author = (issue.user as Record<string, unknown> | undefined)?.login;
  const rawLabels = issue.labels as Array<Record<string, unknown>> | undefined;
  const labels = rawLabels?.map((l) => l.name as string).filter(Boolean) ?? [];
  const body = issue.body as string | undefined;
  const bodyPreview = body ? body.slice(0, BODY_PREVIEW_MAX) : undefined;

  const lines: string[] = [
    GITHUB_EVENT_PREAMBLE,
    "",
    `Event: ${eventType}`,
    `Repository: ${repoFullName}`,
    `Issue #${issueNumber}: ${title ?? "(no title)"}`,
    `Author: ${author ?? "unknown"}`,
  ];

  if (labels.length > 0) {
    lines.push(`Labels: ${labels.join(", ")}`);
  }

  if (bodyPreview) {
    lines.push("");
    lines.push("Description:");
    lines.push(bodyPreview);
    if (body && body.length > BODY_PREVIEW_MAX) {
      lines.push("(truncated)");
    }
  }

  return lines.join("\n");
}
