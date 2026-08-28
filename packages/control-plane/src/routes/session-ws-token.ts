import { applyIdentityEnforcement } from "../auth/identity-enforcement";
import { SessionInternalPaths, sessionScmDisplayFieldsSchema } from "../session/contracts";
import type { Env } from "../types";
import {
  defineRoutes,
  error,
  GITHUB_USER_OR_SERVICE_ROUTE,
  parseJsonBody,
  parsePattern,
  type Route,
} from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

async function handleSessionWsToken(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const rawBody = await parseJsonBody<unknown>(request);
  if (rawBody instanceof Response) return rawBody;

  // The participant identity comes from the verified principal; body SCM
  // credentials are rejected (tokens arrive via the exchange; enrichment
  // reads the store server-side).
  const enforcement = applyIdentityEnforcement(ctx, "ws-token", rawBody);
  if (enforcement.rejection) return enforcement.rejection;

  const parsedBody = sessionScmDisplayFieldsSchema.safeParse(rawBody);
  if (!parsedBody.success) return error("Invalid websocket token body", 400);
  const body = parsedBody.data;

  const userId = enforcement.enforced.participantUserId;
  const canonicalUserId = enforcement.enforced.canonicalUserId;

  return ctx.metrics.time("do_fetch", () =>
    ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.wsToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        canonicalUserId,
        scmLogin: body.scmLogin,
        scmName: body.scmName,
        scmEmail: body.scmEmail,
      }),
    })
  );
}

export const sessionWsTokenRoutes: Route[] = defineRoutes(GITHUB_USER_OR_SERVICE_ROUTE, [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/ws-token"),
    handler: handleSessionWsToken,
  }),
]);
