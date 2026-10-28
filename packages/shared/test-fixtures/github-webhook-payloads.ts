/**
 * GitHub webhook payloads shared by the normalizer test suites, with one
 * payload per catalog event type in CATALOG_PAYLOADS.
 */

export const repo = {
  id: 9001,
  name: "my-app",
  owner: { login: "acme-org" },
};

export const sender = { login: "dev-user", type: "User" };

export const basePR = {
  number: 42,
  title: "Add new feature",
  body: "This PR adds a great new feature.",
  user: { login: "pr-author" },
  head: { ref: "feature/my-feature", sha: "abc1234def5678" },
  base: { ref: "main" },
  labels: [{ name: "enhancement" }, { name: "review-needed" }],
  changed_files: 3,
};

export const pullRequestOpenedPayload = {
  action: "opened",
  repository: repo,
  sender,
  pull_request: basePR,
};

export const pullRequestSynchronizePayload = {
  action: "synchronize",
  repository: repo,
  sender,
  pull_request: {
    ...basePR,
    head: { ref: "feature/my-feature", sha: "deadbeef99" },
  },
};

export const pullRequestClosedPayload = {
  action: "closed",
  repository: repo,
  sender,
  pull_request: {
    ...basePR,
    merged: true,
  },
};

export const issueCommentPayload = {
  action: "created",
  repository: repo,
  sender,
  issue: {
    id: 10010,
    number: 10,
    title: "Bug report",
  },
  comment: {
    id: 9001,
    user: { login: "commenter-user" },
    body: "This is a helpful comment.",
  },
};

export const reviewCommentPayload = {
  action: "created",
  repository: repo,
  sender,
  pull_request: basePR,
  comment: {
    id: 5555,
    user: { login: "reviewer-user" },
    body: "Please fix this line.",
    path: "src/index.ts",
    diff_hunk: "@@ -1,3 +1,4 @@\n+import foo from 'bar';",
  },
};

export const checkSuiteCompletedPayload = {
  action: "completed",
  repository: repo,
  sender,
  check_suite: {
    id: 77777,
    head_branch: "feature/my-feature",
    head_sha: "abc1234def5678",
    conclusion: "failure",
    pull_requests: [{ number: 42 }, { number: 43 }],
  },
};

export const workflowRunCompletedPayload = {
  action: "completed",
  repository: repo,
  sender,
  workflow_run: {
    id: 123456789,
    run_attempt: 1,
    name: "CI",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "abc1234def5678",
    path: ".github/workflows/ci.yml",
    html_url: "https://github.com/acme-org/my-app/actions/runs/123456789",
  },
};

export const issuesOpenedPayload = {
  action: "opened",
  repository: repo,
  sender,
  issue: {
    id: 50101,
    number: 101,
    title: "New bug found",
    body: "Steps to reproduce...",
    user: { login: "reporter" },
    labels: [],
  },
};

export const issuesLabeledPayload = {
  action: "labeled",
  repository: repo,
  sender,
  issue: {
    id: 50101,
    number: 101,
    title: "New bug found",
    body: "Steps to reproduce...",
    user: { login: "reporter" },
    labels: [{ name: "bug" }, { name: "priority:high" }],
  },
};

/** A payload per catalog event type. */
export const CATALOG_PAYLOADS: Record<string, [event: string, payload: Record<string, unknown>]> = {
  "pull_request.opened": ["pull_request", pullRequestOpenedPayload],
  "pull_request.synchronize": ["pull_request", pullRequestSynchronizePayload],
  "pull_request.ready_for_review": [
    "pull_request",
    { ...pullRequestOpenedPayload, action: "ready_for_review" },
  ],
  "pull_request.closed": ["pull_request", pullRequestClosedPayload],
  "issue_comment.created": ["issue_comment", issueCommentPayload],
  "pull_request_review_comment.created": ["pull_request_review_comment", reviewCommentPayload],
  "check_suite.completed": ["check_suite", checkSuiteCompletedPayload],
  "workflow_run.completed": ["workflow_run", workflowRunCompletedPayload],
  // The shared opened fixture covers the unlabelled case; a catalog entry that
  // promises `label` has to be checked against a payload that carries labels.
  "issues.opened": [
    "issues",
    { ...issuesOpenedPayload, issue: { ...issuesOpenedPayload.issue, labels: [{ name: "bug" }] } },
  ],
  "issues.labeled": ["issues", issuesLabeledPayload],
};
