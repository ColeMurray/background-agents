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
import { isUniqueConstraintError } from "../db/errors";
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

function parseRevision(request: Request): number | null {
  const raw = request.headers.get("If-Match")?.replaceAll('"', "");
  if (!raw || !/^\d+$/.test(raw)) return null;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

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
  if (isUniqueConstraintError(cause)) {
    return json({ error: "Role name already exists", code: "rbac_conflict" }, 409);
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
        await service.requirePermission(ctx.principal.userId, "workspace.roles.read");
        return json(await service.listRoles());
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "POST",
    pattern: /^\/roles$/,
    authorization: requirePermission("workspace.roles.manage"),
    cacheControl: "private, no-store",
    handler: async (request, _env, _match, ctx) => {
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) return body;
      const service = new AuthorizationService(ctx.db);
      try {
        const actor = await service.requirePermission(
          ctx.principal.userId,
          "workspace.roles.manage"
        );
        const role = await service.createRole(
          body,
          ctx.principal.userId,
          actor.authorizationVersion,
          ctx.request_id
        );
        return json(role, 201);
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
        await service.requirePermission(ctx.principal.userId, "workspace.roles.read");
        const role = await service.getRole(decodeURIComponent(match.groups!.id));
        return role ? json(role) : error("Role not found", 404);
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "PUT",
    pattern: /^\/roles\/(?<id>[^/]+)$/,
    authorization: requirePermission("workspace.roles.manage"),
    cacheControl: "private, no-store",
    handler: async (request, _env, match, ctx) => {
      const revision = parseRevision(request);
      if (!revision) return error("If-Match revision is required", 428);
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) return body;
      const service = new AuthorizationService(ctx.db);
      try {
        const actor = await service.requirePermission(
          ctx.principal.userId,
          "workspace.roles.manage"
        );
        return json(
          await service.replaceRole(
            decodeURIComponent(match.groups!.id),
            revision,
            body,
            ctx.principal.userId,
            actor.authorizationVersion,
            ctx.request_id
          )
        );
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
  {
    method: "DELETE",
    pattern: /^\/roles\/(?<id>[^/]+)$/,
    authorization: requirePermission("workspace.roles.manage"),
    cacheControl: "private, no-store",
    handler: async (_request, _env, match, ctx) => {
      const service = new AuthorizationService(ctx.db);
      try {
        const actor = await service.requirePermission(
          ctx.principal.userId,
          "workspace.roles.manage"
        );
        await service.deleteRole(
          decodeURIComponent(match.groups!.id),
          ctx.principal.userId,
          actor.authorizationVersion,
          ctx.request_id
        );
        return new Response(null, { status: 204 });
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
        await service.requirePermission(ctx.principal.userId, "workspace.members.read");
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
    handler: async (request, env, match, ctx) => {
      const targetUserId = decodeURIComponent(match.groups!.id);
      if (!isCanonicalUserId(targetUserId)) return error("Invalid user ID", 400);
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) return body;
      const service = new AuthorizationService(ctx.db);
      try {
        const actor = await service.requirePermission(
          ctx.principal.userId,
          "workspace.members.manage"
        );
        const parsed = replaceMemberRoleInputSchema.parse(body);
        await service.replaceMemberRole({
          targetUserId,
          roleId: parsed.roleId,
          expectedVersion: parsed.authorizationVersion,
          actorUserId: ctx.principal.userId,
          actorAuthorizationVersion: actor.authorizationVersion,
          actorCanTransferOwnership: actor.permissions.includes("workspace.transfer_ownership"),
          bootstrapOwnerEmail: env.RBAC_BOOTSTRAP_OWNER_EMAIL,
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
    handler: async (request, env, match, ctx) => {
      const targetUserId = decodeURIComponent(match.groups!.id);
      if (!isCanonicalUserId(targetUserId)) return error("Invalid user ID", 400);
      const body = await parseJsonBody<unknown>(request);
      if (body instanceof Response) return body;
      const service = new AuthorizationService(ctx.db);
      try {
        const actor = await service.requirePermission(
          ctx.principal.userId,
          "workspace.members.manage"
        );
        const parsed = replaceMemberStatusInputSchema.parse(body);
        await service.replaceMemberStatus({
          targetUserId,
          accessStatus: parsed.accessStatus,
          expectedVersion: parsed.authorizationVersion,
          actorUserId: ctx.principal.userId,
          actorAuthorizationVersion: actor.authorizationVersion,
          actorCanTransferOwnership: actor.permissions.includes("workspace.transfer_ownership"),
          bootstrapOwnerEmail: env.RBAC_BOOTSTRAP_OWNER_EMAIL,
          requestId: ctx.request_id,
        });
        return json(await service.getEffectiveAuthorization(targetUserId));
      } catch (cause) {
        return rbacErrorResponse(cause);
      }
    },
  },
]);
