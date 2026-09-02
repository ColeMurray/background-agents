import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  requirePermission,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

/**
 * Manual PR sync (design §5.3): forwards to the session DO's internal
 * refresh route, which kicks a background read-through and answers 202
 * immediately. Deliberately no session-index touch — PR changes must never
 * reorder the session list.
 */
async function handleRefreshPullRequests(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.pullRequestsRefresh, {
    method: "POST",
  });
}

export const sessionPullRequestRoutes: Route[] = defineRoutes(GITHUB_USER_OR_SERVICE_ROUTE, [
  sessionRoute({
    method: "POST",
    path: "/sessions/:id/pull-requests/refresh",
    authorization: requirePermission("sessions.lifecycle"),
    handler: handleRefreshPullRequests,
  }),
]);
