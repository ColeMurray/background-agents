import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { applyIdentityEnforcement } from "../routing/identity-enforcement";
import { SessionInternalPaths, sessionScmDisplayFieldsSchema } from "../session/contracts";
import { UserStore } from "../db/user-store";
import { resolveGitHubEnrichmentForRequest, type GitHubEnrichment } from "../session/identity";
import { resolveScmProviderFromEnv } from "../source-control/config";
import {
  GitHubAttributionUnavailableError,
  resolveGitHubCredentialAuthority,
} from "../source-control/github-credential-authority";
import type { Env } from "../types";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, requireSession } from "./shared";
import { parseJsonBody } from "./body";
import { dispatchSession, type SessionRouteContext } from "./session-route";

export async function handleSessionWsToken(
  request: Request,
  env: Env,
  params: { id: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;

  const rawBody = await parseJsonBody(request);
  if (rawBody instanceof Response) return rawBody;

  // The participant identity comes from the verified principal. Current
  // callers send identity/display fields only; token fields are rejected.
  const enforcement = applyIdentityEnforcement(ctx, "ws-token", rawBody);
  if (enforcement.rejection) return enforcement.rejection;

  const parsedBody = sessionScmDisplayFieldsSchema.safeParse(rawBody);
  if (!parsedBody.success) return error("Invalid websocket token body", 400);
  const body = parsedBody.data;

  const authorization = ctx.authorization;
  if (!authorization) return error("Authorization unavailable", 503);
  const userId = enforcement.enforced.participantUserId;
  const canonicalUserId = authorization.userId;
  const isGitHub = resolveScmProviderFromEnv(env.SCM_PROVIDER) === "github";
  let enrichment: GitHubEnrichment | null = null;
  if (isGitHub) {
    try {
      enrichment = await resolveGitHubEnrichmentForRequest(
        new UserStore(ctx.db),
        canonicalUserId,
        await resolveGitHubCredentialAuthority(ctx, request.headers)
      );
    } catch (retrievalError) {
      if (!(retrievalError instanceof GitHubAttributionUnavailableError)) throw retrievalError;
    }
  }

  return ctx.metrics.time("do_fetch", () =>
    ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.wsToken, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId,
        canonicalUserId,
        scmUserId: enrichment?.scmUserId,
        scmLogin: isGitHub ? (enrichment?.scmLogin ?? null) : body.scmLogin,
        scmName: isGitHub ? (enrichment?.displayName ?? null) : body.scmName,
        scmEmail: isGitHub ? (enrichment?.email ?? null) : body.scmEmail,
      }),
    })
  );
}

export const sessionWsTokenRoutes = new Hono<ControlPlaneHonoEnv>();

sessionWsTokenRoutes.post(
  "/sessions/:id/ws-token",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requireSession("read"),
  }),
  (c) => dispatchSession(c, handleSessionWsToken)
);
