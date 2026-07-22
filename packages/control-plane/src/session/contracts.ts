/**
 * Contract constants for Session Durable Object internal endpoints.
 * Router and SessionDO must both import these to prevent path drift.
 */

export const SessionInternalPaths = {
  init: "/internal/init",
  state: "/internal/state",
  prompt: "/internal/prompt",
  stop: "/internal/stop",
  sandboxEvent: "/internal/sandbox-event",
  createMediaArtifact: "/internal/create-media-artifact",
  attachments: "/internal/attachments",
  participants: "/internal/participants",
  events: "/internal/events",
  artifacts: "/internal/artifacts",
  messages: "/internal/messages",
  createPr: "/internal/create-pr",
  // Static path + artifactId query param: the router matches paths as exact
  // strings, so the artifact id cannot ride in the path.
  pullRequestArtifactSnapshot: "/internal/pull-request-artifact-snapshot",
  pullRequestsRefresh: "/internal/pull-requests-refresh",
  wsToken: "/internal/ws-token",
  archive: "/internal/archive",
  unarchive: "/internal/unarchive",
  verifySandboxToken: "/internal/verify-sandbox-token",
  bootProgress: "/internal/boot-progress",
  openaiTokenRefresh: "/internal/openai-token-refresh",
  scmCredentials: "/internal/scm-credentials",
  tunnelUrls: "/internal/tunnel-urls",
  spawnContext: "/internal/spawn-context",
  childSummary: "/internal/child-summary",
  updateTitle: "/internal/update-title",
  cancel: "/internal/cancel",
  childSessionUpdate: "/internal/child-session-update",
  diffState: "/internal/diff-state",
  diffStore: "/internal/diff-store",
  diffFailure: "/internal/diff-failure",
  diffResolveFile: "/internal/diff-resolve-file",
  diffRetry: "/internal/diff-retry",
} as const;

export type SessionInternalPath = (typeof SessionInternalPaths)[keyof typeof SessionInternalPaths];

const INTERNAL_ORIGIN = "http://internal";

export function buildSessionInternalUrl(path: SessionInternalPath, search?: string): string {
  return `${INTERNAL_ORIGIN}${path}${search ?? ""}`;
}
