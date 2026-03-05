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
  participants: "/internal/participants",
  events: "/internal/events",
  artifacts: "/internal/artifacts",
  messages: "/internal/messages",
  createPr: "/internal/create-pr",
  wsToken: "/internal/ws-token",
  archive: "/internal/archive",
  unarchive: "/internal/unarchive",
  verifySandboxToken: "/internal/verify-sandbox-token",
  openaiTokenRefresh: "/internal/openai-token-refresh",
  spawnContext: "/internal/spawn-context",
  childSummary: "/internal/child-summary",
  cancel: "/internal/cancel",
  childSessionUpdate: "/internal/child-session-update",
} as const;

export type SessionInternalPath = (typeof SessionInternalPaths)[keyof typeof SessionInternalPaths];

const INTERNAL_ORIGIN = "http://internal";

export function buildSessionInternalUrl(path: SessionInternalPath, search?: string): string {
  return `${INTERNAL_ORIGIN}${path}${search ?? ""}`;
}
