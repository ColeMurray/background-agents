import type { PermissionId } from "@open-inspect/shared/rbac";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { checkEnvironmentAccess } from "@open-inspect/shared";
import { resourceViewer } from "../authorization/resource-viewer";
import { EnvironmentStore } from "../db/environments";
import { json, type RequestContext } from "./shared";

export interface SessionTarget {
  environmentId?: string | null;
  hasRepository: boolean;
}

/** Enforce use of the environment or repository inherited by a new session. */
export async function authorizeSessionTarget(
  ctx: RequestContext,
  target: SessionTarget
): Promise<Response | null> {
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
  if (target.environmentId) {
    const environment = await new EnvironmentStore(ctx.db).getById(target.environmentId);
    if (!environment) return json({ error: "Environment not found" }, 404);
    const access = checkEnvironmentAccess(
      await resourceViewer(ctx),
      {
        ownerTeamId: environment.owner_team_id,
      },
      "use"
    );
    if (!access.allowed) {
      return access.reason === "not_member"
        ? json({ error: "Environment not found" }, 404)
        : json(
            { error: "Forbidden", code: "environment_action_denied", reason_code: access.reason },
            403
          );
    }
  }
  return null;
}
