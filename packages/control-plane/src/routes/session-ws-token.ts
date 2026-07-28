import { applyIdentityEnforcement, getCanonicalUserSummary } from "../auth/identity-enforcement";
import { UserStore } from "../db/user-store";
import { z } from "zod";
import { SessionInternalPaths } from "../session/contracts";
import type { Env } from "../types";
import { error, parseJsonBody, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const wsTokenBodySchema = z.strictObject({});

async function handleSessionWsToken(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const parsedBody = wsTokenBodySchema.safeParse(body);
  if (!parsedBody.success) return error("Invalid request body", 400);

  const enforcement = applyIdentityEnforcement(ctx, "ws-token", parsedBody.data);
  if (enforcement.rejection) return enforcement.rejection;
  const userId = enforcement.enforced.participantUserId;
  const canonicalUserId = enforcement.enforced.canonicalUserId;
  const user = canonicalUserId
    ? await getCanonicalUserSummary(new UserStore(ctx.db), canonicalUserId)
    : null;

  return ctx.metrics.time("do_fetch", () =>
    ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.wsToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        authName: user?.authName,
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
