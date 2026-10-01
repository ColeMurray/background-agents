import type { PermissionId } from "@open-inspect/shared/rbac";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { checkEnvironmentAccess } from "@open-inspect/shared";
import { resourceViewer } from "../authorization/resource-viewer";
import { EnvironmentStore } from "../db/environments";
import { json, type RequestContext } from "./shared";

export interface SessionTarget {
  environmentId?: string | null;
  hasRepository: boolean;
  ownerTeamId: string | null;
}

/** Authorize target use and bind environment ownership to the destination session. */
export async function authorizeSessionTarget(
  ctx: RequestContext,
  target: SessionTarget
): Promise<Response | null> {
  if (!ctx.principal) return null;
  const sandbox = ctx.principal.kind === "sandbox";
  if (!sandbox) {
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
  }
  if (target.environmentId) {
    const environment = await new EnvironmentStore(ctx.db).getById(target.environmentId);
    // Dangling environment provenance does not invalidate a sandbox's inherited clone context.
    if (!environment) return sandbox ? null : json({ error: "Environment not found" }, 404);
    if (!sandbox) {
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
    if (environment.owner_team_id !== null && environment.owner_team_id !== target.ownerTeamId) {
      return json(
        {
          error: "Environment must belong to the session's owner team",
          code: "environment_team_mismatch",
          reason_code: "environment_team_mismatch",
        },
        409
      );
    }
  }
  return null;
}
