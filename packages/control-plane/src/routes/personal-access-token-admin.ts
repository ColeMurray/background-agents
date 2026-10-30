/**
 * Workspace governance of personal access tokens, for holders of
 * `workspace.personal_access_tokens.manage`: the token policy (a kill switch, a lifetime cap, and a
 * permission ceiling, all applied to existing tokens), every member's tokens, and revoking any of
 * them. Human browser sessions only; no route here accepts a token.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  personalAccessTokenPolicySchema,
  type PersonalAccessTokenPolicySnapshot,
} from "@open-inspect/shared/types/personal-access-tokens";
import { PersonalAccessTokenPolicyStore } from "../db/personal-access-token-policy";
import { PersonalAccessTokenStore } from "../db/personal-access-tokens";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseBody } from "./body";
import {
  error,
  json,
  requirePermission,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  type UserRouteContext,
} from "./shared";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const listQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  cursor: z.string().min(1).optional(),
});

function policyEtag(revision: number): string {
  return `"pat-policy-${revision}"`;
}

function policyResponse(policy: PersonalAccessTokenPolicySnapshot): Response {
  const response = json(policy);
  response.headers.set("ETag", policyEtag(policy.revision));
  return response;
}

async function handleGetPolicy(
  _request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  return policyResponse(await new PersonalAccessTokenPolicyStore(ctx.db).get());
}

async function handleReplacePolicy(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) return error("If-Match revision is required", 428);
  const match = /^"pat-policy-(0|[1-9]\d*)"$/.exec(ifMatch);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    return error("Invalid If-Match revision", 400);
  }
  const parsed = await parseBody(request, personalAccessTokenPolicySchema);
  if (parsed instanceof Response) return parsed;

  const store = new PersonalAccessTokenPolicyStore(ctx.db);
  const result = await store.replace({
    before: await store.get(),
    expectedRevision: Number(match[1]),
    policy: parsed,
    actorUserId: ctx.principal.userId,
    requestId: ctx.request_id,
    now: Date.now(),
  });
  if (result.status === "conflict") {
    const response = json(
      { error: "The policy changed; reload and retry", code: "policy_conflict" },
      412
    );
    response.headers.set("ETag", policyEtag(result.policy.revision));
    return response;
  }
  return policyResponse(result.policy);
}

async function handleListTokens(
  request: Request,
  _env: Env,
  _params: object,
  ctx: UserRouteContext
): Promise<Response> {
  const query = listQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return error("Invalid query", 400);
  const page = await new PersonalAccessTokenStore(ctx.db).listAll({
    limit: query.data.limit ?? DEFAULT_PAGE_SIZE,
    cursor: query.data.cursor,
  });
  if (!page) return error("Invalid cursor", 400);
  return json(page);
}

async function handleRevokeToken(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const store = new PersonalAccessTokenStore(ctx.db);
  const ownerUserId = await store.ownerOf(params.id);
  const revoked =
    ownerUserId &&
    (await store.revoke({
      userId: ownerUserId,
      tokenId: params.id,
      actorUserId: ctx.principal.userId,
      now: Date.now(),
      requestId: ctx.request_id,
    }));
  if (!revoked) return error("Personal access token not found", 404);
  return json({ revoked: true });
}

async function handleRevokeMemberTokens(
  _request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const revoked = await new PersonalAccessTokenStore(ctx.db).revokeAll({
    userId: params.id,
    actorUserId: ctx.principal.userId,
    now: Date.now(),
    requestId: ctx.request_id,
  });
  return json({ revoked });
}

export const personalAccessTokenAdminRoutes = new Hono<ControlPlaneHonoEnv>();

const MANAGE_TOKENS = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  authorization: requirePermission("workspace.personal_access_tokens.manage", { service: "deny" }),
  cacheControl: "private, no-store",
});

personalAccessTokenAdminRoutes.get("/settings/personal-access-token-policy", MANAGE_TOKENS, (c) =>
  dispatch(c, handleGetPolicy)
);
personalAccessTokenAdminRoutes.put("/settings/personal-access-token-policy", MANAGE_TOKENS, (c) =>
  dispatch(c, handleReplacePolicy)
);
personalAccessTokenAdminRoutes.get("/settings/personal-access-tokens", MANAGE_TOKENS, (c) =>
  dispatch(c, handleListTokens)
);
personalAccessTokenAdminRoutes.delete("/settings/personal-access-tokens/:id", MANAGE_TOKENS, (c) =>
  dispatch(c, handleRevokeToken)
);
personalAccessTokenAdminRoutes.delete("/members/:id/personal-access-tokens", MANAGE_TOKENS, (c) =>
  dispatch(c, handleRevokeMemberTokens)
);
