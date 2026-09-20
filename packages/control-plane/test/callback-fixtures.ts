import type { SessionCallbackJob } from "@open-inspect/shared/types/session-callback-jobs";

export const SLACK_CONTEXT = {
  source: "slack" as const,
  channel: "C123",
  threadTs: "123.45",
  repoFullName: "acme/web",
  model: "test-model",
};
export const LINEAR_CONTEXT = {
  source: "linear" as const,
  issueId: "issue-1",
  issueIdentifier: "ENG-1",
  issueUrl: "https://linear.app/acme/issue/ENG-1",
  model: "test-model",
};
export const AUTOMATION_CONTEXT = {
  source: "automation" as const,
  automationId: "auto-1",
  runId: "run-1",
  automationName: "Nightly",
};
export const COMPLETION_JOB = {
  version: 1,
  type: "slack.completed",
  payload: {
    sessionId: "session-1",
    messageId: "message-1",
    timestamp: 1_800_000_000_000,
    success: true,
    context: SLACK_CONTEXT,
  },
} satisfies SessionCallbackJob;
