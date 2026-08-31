import type { PermissionId } from "@open-inspect/shared/rbac";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { json, type RequestContext } from "./shared";

export interface SessionTarget {
  environmentId?: string | null;
  hasRepository: boolean;
}

/** Enforce use of the environment or repository inherited by a new session. */
export function authorizeSessionTarget(
  ctx: RequestContext,
  target: SessionTarget
): Response | null {
  if (ctx.principal?.kind !== "user" && ctx.principal?.kind !== "service") return null;

  const permission: PermissionId | null = target.environmentId
    ? "environments.use"
    : target.hasRepository
      ? "repositories.use"
      : null;
  if (!permission) return null;

  if (
    ctx.principal.kind === "service" &&
    !serviceAllowsPermission(ctx.principal.service, permission)
  ) {
    return json({ error: "Forbidden", code: "service_capability_required" }, 403);
  }
  if (!ctx.authorization) {
    return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
  }
  if (!ctx.authorization.permissions.includes(permission)) {
    return json({ error: "Forbidden", code: "permission_required", permission }, 403);
  }
  return null;
}
