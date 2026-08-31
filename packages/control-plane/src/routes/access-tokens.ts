/**
 * Managing personal access tokens.
 *
 * Every route here is `{ kind: "user" }` — human browser sessions only. That
 * is load-bearing rather than incidental: a token that could mint another
 * token would make revocation meaningless, since a leaked credential could
 * issue itself a fresh one before anyone noticed. Access-token principals are
 * a distinct kind precisely so this policy excludes them.
 */

import {
  ACCESS_TOKEN_MAX_TTL_DAYS,
  createAccessTokenRequestSchema,
} from "@open-inspect/shared/types/access-tokens";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import type { Env } from "../types";
import {
  ACTIVE_SELF,
  defineRoutes,
  error,
  json,
  parsePattern,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type Route,
  type UserRouteContext,
} from "./shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function listTokens(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const tokens = await new PersonalAccessTokenStore(ctx.db).list(ctx.principal.userId);
  return json({ tokens });
}

async function createToken(
  request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error("Invalid JSON body", 400);
  }

  const parsed = createAccessTokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return error(
      `Invalid access token request: a name is required and expiresInDays must be 1-${ACCESS_TOKEN_MAX_TTL_DAYS}`,
      400
    );
  }

  const { name, expiresInDays } = parsed.data;
  const created = await new PersonalAccessTokenStore(ctx.db).create({
    userId: ctx.principal.userId,
    name,
    expiresAt: expiresInDays === undefined ? null : Date.now() + expiresInDays * MS_PER_DAY,
  });

  // The only response that carries the plaintext token, so it must not be
  // retained by a browser or any intermediary.
  const response = json(created, 201);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function revokeToken(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const id = match.groups?.id;
  if (!id) return error("Invalid access token id", 400);
  const revoked = await new PersonalAccessTokenStore(ctx.db).revoke(ctx.principal.userId, id);
  if (!revoked) return error("Access token not found", 404);
  return json({ revoked: true });
}

export const accessTokenRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    pattern: parsePattern("/access-tokens"),
    authorization: ACTIVE_SELF,
    handler: listTokens,
  },
  {
    method: "POST",
    pattern: parsePattern("/access-tokens"),
    authorization: ACTIVE_SELF,
    handler: createToken,
  },
  {
    method: "DELETE",
    pattern: parsePattern("/access-tokens/:id"),
    authorization: ACTIVE_SELF,
    handler: revokeToken,
  },
]);
