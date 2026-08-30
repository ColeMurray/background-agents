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
import type { Route } from "./shared";
import {
  AUTHENTICATED_USER,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  defineRoutes,
  error,
  json,
  parseJsonBody,
  requirePermission,
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

export const rbacRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_HUMAN_USER_ROUTE, [
  {
    method: "GET",
    pattern: /^\/me\/authorization$/,
    authorization: AUTHENTICATED_USER,
    cacheControl: "private, no-store",
    handler: async (_request, env, _match, ctx) => {
      const service = new AuthorizationService(ctx.db);
      try {
        return json(await service.getEffectiveAuthorization(ctx.principal.userId));
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/roles$/,
    authorization: requirePermission("workspace.roles.read"),
    cacheControl: "private, no-store",
    handler: async (_request, _env, _match, ctx) => {
      const service = new AuthorizationService(ctx.db);
      try {
        return json(await service.listRoles());
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/roles\/(?<id>[^/]+)$/,
    authorization: requirePermission("workspace.roles.read"),
    cacheControl: "private, no-store",
    handler: async (_request, _env, match, ctx) => {
      const service = new AuthorizationService(ctx.db);
      try {
        const role = await service.getRole(decodeURIComponent(match.groups!.id));
        return role ? json(role) : error("Role not found", 404);
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "GET",
    pattern: /^\/members$/,
    authorization: requirePermission("workspace.members.read"),
    cacheControl: "private, no-store",
    handler: async (_request, _env, _match, ctx) => {
      const service = new AuthorizationService(ctx.db);
      try {
        return json(await service.listMembers());
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "PUT",
    pattern: /^\/members\/(?<id>[^/]+)\/role$/,
    authorization: requirePermission("workspace.members.manage"),
    cacheControl: "private, no-store",
    handler: async (request, _env, match, ctx) => {
      const targetUserId = decodeURIComponent(match.groups!.id);
      if (!isCanonicalUserId(targetUserId)) return error("Invalid user ID", 400);
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
        return json(await service.getEffectiveAuthorization(targetUserId));
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "PUT",
    pattern: /^\/members\/(?<id>[^/]+)\/status$/,
    authorization: requirePermission("workspace.members.manage"),
    cacheControl: "private, no-store",
    handler: async (request, _env, match, ctx) => {
      const targetUserId = decodeURIComponent(match.groups!.id);
      if (!isCanonicalUserId(targetUserId)) return error("Invalid user ID", 400);
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
        return json(await service.getEffectiveAuthorization(targetUserId));
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
]);
