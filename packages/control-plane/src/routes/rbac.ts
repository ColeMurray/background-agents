import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import {
  replaceMemberRoleInputSchema,
  replaceMemberStatusInputSchema,
} from "@open-inspect/shared/rbac";
import { Hono } from "hono";
import { ZodError } from "zod";
import {
  AuthorizationError,
  AuthorizationService,
  RbacConflictError,
} from "../authorization/service";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import {
  AUTHENTICATED_USER,
  SCM_AGNOSTIC_HUMAN_USER_ROUTE,
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

async function handleGetCurrentAuthorization(
  _request: Request,
  _env: Env,
  _params: object,
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
  _params: object,
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
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const service = new AuthorizationService(ctx.db);
  try {
    const role = await service.getRole(params.id);
    return role ? json(role) : error("Role not found", 404);
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

async function handleListMembers(
  _request: Request,
  _env: Env,
  _params: object,
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
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const targetUserId = params.id;
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
    return new Response(null, { status: 204 });
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

async function handleReplaceMemberStatus(
  request: Request,
  _env: Env,
  params: { id: string },
  ctx: UserRouteContext
): Promise<Response> {
  const targetUserId = params.id;
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
    return new Response(null, { status: 204 });
  } catch (cause) {
    return rbacErrorResponse(cause);
  }
}

const PRIVATE_NO_STORE = { cacheControl: "private, no-store" } as const;

export const rbacRoutes = new Hono<ControlPlaneHonoEnv>();

rbacRoutes.get(
  "/me/authorization",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    ...PRIVATE_NO_STORE,
    authorization: AUTHENTICATED_USER,
  }),
  (c) => dispatch(c, handleGetCurrentAuthorization)
);
rbacRoutes.get(
  "/roles",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    ...PRIVATE_NO_STORE,
    authorization: requirePermission("workspace.roles.read"),
  }),
  (c) => dispatch(c, handleListRoles)
);
rbacRoutes.get(
  "/roles/:id",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    ...PRIVATE_NO_STORE,
    authorization: requirePermission("workspace.roles.read"),
  }),
  (c) => dispatch(c, handleGetRole)
);
rbacRoutes.get(
  "/members",
  admit({
    ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
    ...PRIVATE_NO_STORE,
    authorization: requirePermission("workspace.members.read"),
  }),
  (c) => dispatch(c, handleListMembers)
);
const MEMBERS_MANAGE = admit({
  ...SCM_AGNOSTIC_HUMAN_USER_ROUTE,
  ...PRIVATE_NO_STORE,
  authorization: requirePermission("workspace.members.manage"),
});
rbacRoutes.put("/members/:id/role", MEMBERS_MANAGE, (c) => dispatch(c, handleReplaceMemberRole));
rbacRoutes.put("/members/:id/status", MEMBERS_MANAGE, (c) =>
  dispatch(c, handleReplaceMemberStatus)
);
