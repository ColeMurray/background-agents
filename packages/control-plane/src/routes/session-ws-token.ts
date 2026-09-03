import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { applyIdentityEnforcement } from "../routing/identity-enforcement";
import { SESSION_WEBSOCKET_CONNECT_PERMISSION } from "@open-inspect/shared/rbac";
import { SessionInternalPaths, sessionScmDisplayFieldsSchema } from "../session/contracts";
import type { Env } from "../types";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, parseJsonBody, requirePermission } from "./shared";
import { dispatchSession, type SessionRouteContext } from "./session-route";

export async function handleSessionWsToken(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
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

  const authorization = ctx.authorization;
  if (!authorization) return error("Authorization unavailable", 503);
  const userId = enforcement.enforced.participantUserId;
  const canonicalUserId = authorization.userId;

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

export const sessionWsTokenRoutes = new Hono<ControlPlaneHonoEnv>();

sessionWsTokenRoutes.post(
  "/sessions/:id/ws-token",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission(SESSION_WEBSOCKET_CONNECT_PERMISSION),
  }),
  (c) => dispatchSession(c, handleSessionWsToken)
);
