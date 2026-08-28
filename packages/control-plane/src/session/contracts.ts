/**
 * Contract constants and schemas for Session Durable Object internal endpoints.
 * Router and SessionDO must both import these to prevent path drift.
 */

import { z } from "zod";

/** SCM display fields forwarded from the authenticated route to the Session runtime. */
export const sessionScmDisplayFieldsSchema = z.object({
  scmLogin: z.string().nullable().optional(),
  scmName: z.string().nullable().optional(),
  scmEmail: z.string().nullable().optional(),
});

export const SessionInternalPaths = {
  init: "/internal/init",
  state: "/internal/state",
  snapshot: "/internal/snapshot",
  sandboxAccess: "/internal/sandbox-access",
  prompt: "/internal/prompt",
  autofix: "/internal/autofix",
  stop: "/internal/stop",
  sandboxEvent: "/internal/sandbox-event",
  sandboxError: "/internal/sandbox-error",
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
  expireDraft: "/internal/expire-draft",
  verifySandboxToken: "/internal/verify-sandbox-token",
  openaiTokenRefresh: "/internal/openai-token-refresh",
  xaiTokenRefresh: "/internal/xai-token-refresh",
  scmCredentials: "/internal/scm-credentials",
  tunnelUrls: "/internal/tunnel-urls",
  spawnContext: "/internal/spawn-context",
  activePromptAuthor: "/internal/active-prompt-author",
  childSummary: "/internal/child-summary",
  parentPrompt: "/internal/parent-prompt",
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
