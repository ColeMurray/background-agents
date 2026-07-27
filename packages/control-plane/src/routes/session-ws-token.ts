import { applyIdentityEnforcement } from "../auth/identity-enforcement";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { error, parseJsonBody, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

async function handleSessionWsToken(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = await parseJsonBody<{
    scmLogin?: string;
    scmName?: string;
    authName?: string;
    scmEmail?: string;
  }>(request);
  if (body instanceof Response) return body;

  // The participant identity comes from the verified principal; body SCM
  // credentials are rejected (tokens arrive via the exchange; enrichment
  // reads the store server-side).
  const enforcement = applyIdentityEnforcement(ctx, "ws-token", body);
  if (enforcement.rejection) return enforcement.rejection;
  const userId = enforcement.enforced.participantUserId;

  return ctx.metrics.time("do_fetch", () =>
    ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.wsToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        scmLogin: body.scmLogin,
        scmName: body.scmName,
        authName: body.authName,
        scmEmail: body.scmEmail,
      }),
    })
  );
}

export const sessionWsTokenRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/ws-token"),
    handler: handleSessionWsToken,
  }),
];
