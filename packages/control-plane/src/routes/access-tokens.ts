/**
 * Managing personal access tokens.
 *
 * Every route here is `{ kind: "user" }` — human browser sessions only. That
 * is load-bearing rather than incidental: a token that could mint another
 * token would make revocation meaningless, since a leaked credential could
 * issue itself a fresh one before anyone noticed. Access-token principals are
 * a distinct kind precisely so this policy excludes them.
 */

import { Hono } from "hono";
import { parseBody } from "./body";
import {
  ACCESS_TOKEN_MAX_TTL_DAYS,
  createAccessTokenRequestSchema,
} from "@open-inspect/shared/types/access-tokens";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  ACTIVE_SELF,
  error,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function listTokens(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const tokens = await new PersonalAccessTokenStore(ctx.db).list(ctx.principal.userId);
  return json({ tokens });
}

async function createToken(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const parsed = await parseBody(
    request,
    createAccessTokenRequestSchema,
    `Invalid access token request: a name is required and expiresInDays must be 1-${ACCESS_TOKEN_MAX_TTL_DAYS}`
  );
  if (parsed instanceof Response) return parsed;

  const { name, expiresInDays } = parsed;
  const created = await new PersonalAccessTokenStore(ctx.db).create({
    userId: ctx.principal.userId,
    name,
    expiresAt: expiresInDays === undefined ? null : Date.now() + expiresInDays * MS_PER_DAY,
  });

  // The only response that carries the plaintext token. The route policy puts
  // `private, no-store` on every response here, so no cache retains it.
  return json(created, 201);
}

async function revokeToken(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const { id } = params;
  const revoked = await new PersonalAccessTokenStore(ctx.db).revoke(ctx.principal.userId, id);
  if (!revoked) return error("Access token not found", 404);
  return json({ revoked: true });
}

export const accessTokenRoutes = new Hono<ControlPlaneHonoEnv>();

/**
 * One policy for all three routes. `private, no-store` is not incidental: the
 * creation response carries the plaintext token, and a listing names a user's
 * credentials and when each was last used. Neither belongs in a shared cache
 * or a browser's disk cache.
 */
const TOKEN_ROUTE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: ACTIVE_SELF,
  cacheControl: "private, no-store",
});

accessTokenRoutes.get("/access-tokens", TOKEN_ROUTE, (c) => dispatch(c, listTokens));

accessTokenRoutes.post("/access-tokens", TOKEN_ROUTE, (c) => dispatch(c, createToken));

accessTokenRoutes.delete("/access-tokens/:id", TOKEN_ROUTE, (c) => dispatch(c, revokeToken));
