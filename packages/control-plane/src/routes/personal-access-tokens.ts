/**
 * Issuing, listing, and revoking one's own personal access tokens.
 *
 * Every route here authenticates a human browser session and declares no `personalAccessTokens`,
 * so a token can never reach them. That is load-bearing: a token that could mint another token
 * would make revocation meaningless, since a leaked credential could issue itself a successor.
 */

import { Hono } from "hono";
import {
  createPersonalAccessTokenRequestSchema,
  isPersonalAccessTokenGrantable,
  PERSONAL_ACCESS_TOKEN_ERROR_CODES,
  PERSONAL_ACCESS_TOKEN_MAX_PER_USER,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  ACTIVE_SELF,
  error,
  json,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function handleListTokens(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const tokens = await new PersonalAccessTokenStore(ctx.db).list(ctx.principal.userId);
  return json({ tokens });
}

async function handleIssueToken(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const parsed = await parseBody(request, createPersonalAccessTokenRequestSchema);
  if (parsed instanceof Response) return parsed;
  // Loaded by ACTIVE_SELF admission; a grant may name only what its issuer holds right now.
  const held = new Set(ctx.authorization?.permissions ?? []);
  for (const permission of parsed.permissions) {
    if (!isPersonalAccessTokenGrantable(permission)) {
      return json(
        {
          error: `Personal access tokens cannot be granted ${permission}`,
          code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.permissionNotGrantable,
          permission,
        },
        400
      );
    }
    if (!held.has(permission)) {
      return json(
        {
          error: `You do not hold ${permission}, so a token cannot be granted it`,
          code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.permissionNotHeld,
          permission,
        },
        403
      );
    }
  }

  const now = Date.now();
  const result = await new PersonalAccessTokenStore(ctx.db).issue({
    userId: ctx.principal.userId,
    name: parsed.name,
    permissions: parsed.permissions,
    expiresAt: now + parsed.expiresInDays * MS_PER_DAY,
    now,
    requestId: ctx.request_id,
  });
  if (result.kind === "limit_reached") {
    return json(
      {
        error: `You already hold ${PERSONAL_ACCESS_TOKEN_MAX_PER_USER} personal access tokens; revoke one first`,
        code: PERSONAL_ACCESS_TOKEN_ERROR_CODES.limitReached,
      },
      409
    );
  }
  // The only response that carries the plaintext token; the route policy keeps it out of caches.
  return json(result.token, 201);
}

async function handleRevokeToken(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const revoked = await new PersonalAccessTokenStore(ctx.db).revoke({
    userId: ctx.principal.userId,
    tokenId: params.id,
    actorUserId: ctx.principal.userId,
    now: Date.now(),
    requestId: ctx.request_id,
  });
  if (!revoked) return error("Personal access token not found", 404);
  return json({ revoked: true });
}

export const personalAccessTokenRoutes = new Hono<ControlPlaneHonoEnv>();

/**
 * One policy for all three routes. `private, no-store` matters: the issue response carries the
 * plaintext token, and a listing names a user's credentials and when each was last used.
 */
const OWN_TOKENS = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: ACTIVE_SELF,
  cacheControl: "private, no-store",
});

personalAccessTokenRoutes.get("/personal-access-tokens", OWN_TOKENS, (c) =>
  dispatch(c, handleListTokens)
);
personalAccessTokenRoutes.post("/personal-access-tokens", OWN_TOKENS, (c) =>
  dispatch(c, handleIssueToken)
);
personalAccessTokenRoutes.delete("/personal-access-tokens/:id", OWN_TOKENS, (c) =>
  dispatch(c, handleRevokeToken)
);
