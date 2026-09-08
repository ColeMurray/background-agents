import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { GITHUB_USER_OR_SERVICE_ROUTE, requirePermission } from "./shared";
import { type SessionRouteContext, dispatchSession } from "./session-route";

/**
 * Manual PR sync (design §5.3): forwards to the session DO's internal
 * refresh route, which kicks a background read-through and answers 202
 * immediately. Deliberately no session-index touch — PR changes must never
 * reorder the session list.
 */
export async function handleRefreshPullRequests(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;

  return ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.pullRequestsRefresh, {
    method: "POST",
  });
}

export const sessionPullRequestRoutes = new Hono<ControlPlaneHonoEnv>();

sessionPullRequestRoutes.post(
  "/sessions/:id/pull-requests/refresh",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.lifecycle"),
  }),
  (c) => dispatchSession(c, handleRefreshPullRequests)
);
