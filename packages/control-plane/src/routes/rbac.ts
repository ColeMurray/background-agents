import { AuthorizationError, AuthorizationService } from "../authorization/service";
import type { Env } from "../types";
import type { Route } from "./shared";
import {
  AUTHENTICATED_USER,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  requirePermission,
  type UserRouteContext,
} from "./shared";

function rbacErrorResponse(cause: unknown): Response {
  if (cause instanceof AuthorizationError) {
    return json(
      {
        error: "Forbidden",
        code: cause.code,
        ...(cause.permission ? { permission: cause.permission } : {}),
      },
      cause.status
    );
  }
  return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
}

async function handleGetCurrentAuthorization(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const service = new AuthorizationService(ctx.db);
  try {
    return json(await service.getEffectiveAuthorization(ctx.principal.userId));
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

async function handleListRoles(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const service = new AuthorizationService(ctx.db);
  try {
    return json(await service.listRoles());
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

async function handleGetRole(
  _request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const service = new AuthorizationService(ctx.db);
  try {
    const role = await service.getRole(decodeURIComponent(match.groups!.id));
    return role ? json(role) : error("Role not found", 404);
  } catch (cause) {
    if (cause instanceof URIError) return error("Invalid role ID", 400);
    return rbacErrorResponse(cause);
  }
}

async function handleListMembers(
  _request: Request,
  _env: Env,
  _match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const service = new AuthorizationService(ctx.db);
  try {
    return json(await service.listMembers());
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

export const rbacRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    pattern: /^\/me\/authorization$/,
    authorization: AUTHENTICATED_USER,
    cacheControl: "private, no-store",
    handler: handleGetCurrentAuthorization,
  },
  {
    method: "GET",
    pattern: /^\/roles$/,
    authorization: requirePermission("workspace.roles.read"),
    cacheControl: "private, no-store",
    handler: handleListRoles,
  },
  {
    method: "GET",
    pattern: /^\/roles\/(?<id>[^/]+)$/,
    authorization: requirePermission("workspace.roles.read"),
    cacheControl: "private, no-store",
    handler: handleGetRole,
  },
  {
    method: "GET",
    pattern: /^\/members$/,
    authorization: requirePermission("workspace.members.read"),
    cacheControl: "private, no-store",
    handler: handleListMembers,
  },
]);
