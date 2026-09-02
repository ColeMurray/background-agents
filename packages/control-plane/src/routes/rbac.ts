import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import {
  replaceMemberRoleInputSchema,
  replaceMemberStatusInputSchema,
} from "@open-inspect/shared/rbac";
import { ZodError } from "zod";
import {
  AuthorizationError,
  AuthorizationService,
  RbacConflictError,
} from "../authorization/service";
import type { Env } from "../types";
import type { Route } from "./shared";
import {
  AUTHENTICATED_USER,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
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
  if (cause instanceof RbacConflictError) {
    return json({ error: cause.message, code: "rbac_conflict" }, 409);
  }
  if (cause instanceof ZodError) return error("Invalid request body", 400);
  return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
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
    const roleId = decodePathSegment(match.groups!.id);
    if (roleId === null) return error("Invalid role ID", 400);
    const role = await service.getRole(roleId);
    return role ? json(role) : error("Role not found", 404);
  } catch (cause) {
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

async function handleReplaceMemberRole(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const targetUserId = decodePathSegment(match.groups!.id);
  if (targetUserId === null || !isCanonicalUserId(targetUserId)) {
    return error("Invalid user ID", 400);
  }
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const service = new AuthorizationService(ctx.db);
  try {
    const parsed = replaceMemberRoleInputSchema.parse(body);
    await service.replaceMemberRole({
      targetUserId,
      roleId: parsed.roleId,
      actorUserId: ctx.principal.userId,
      requestId: ctx.request_id,
    });
    return new Response(null, { status: 204 });
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

async function handleReplaceMemberStatus(
  request: Request,
  _env: Env,
  match: RegExpMatchArray,
  ctx: UserRouteContext
): Promise<Response> {
  const targetUserId = decodePathSegment(match.groups!.id);
  if (targetUserId === null || !isCanonicalUserId(targetUserId)) {
    return error("Invalid user ID", 400);
  }
  const body = await parseJsonBody<unknown>(request);
  if (body instanceof Response) return body;
  const service = new AuthorizationService(ctx.db);
  try {
    const parsed = replaceMemberStatusInputSchema.parse(body);
    await service.replaceMemberStatus({
      targetUserId,
      suspended: parsed.suspended,
      actorUserId: ctx.principal.userId,
      requestId: ctx.request_id,
    });
    return new Response(null, { status: 204 });
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

export const rbacRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    path: "/me/authorization",
    authorization: AUTHENTICATED_USER,
    cacheControl: "private, no-store",
    handler: handleGetCurrentAuthorization,
  },
  {
    method: "GET",
    path: "/roles",
    authorization: requirePermission("workspace.roles.read"),
    cacheControl: "private, no-store",
    handler: handleListRoles,
  },
  {
    method: "GET",
    path: "/roles/:id",
    authorization: requirePermission("workspace.roles.read"),
    cacheControl: "private, no-store",
    handler: handleGetRole,
  },
  {
    method: "GET",
    path: "/members",
    authorization: requirePermission("workspace.members.read"),
    cacheControl: "private, no-store",
    handler: handleListMembers,
  },
  {
    method: "PUT",
    path: "/members/:id/role",
    authorization: requirePermission("workspace.members.manage"),
    cacheControl: "private, no-store",
    handler: handleReplaceMemberRole,
  },
  {
    method: "PUT",
    path: "/members/:id/status",
    authorization: requirePermission("workspace.members.manage"),
    cacheControl: "private, no-store",
    handler: handleReplaceMemberStatus,
  },
]);
