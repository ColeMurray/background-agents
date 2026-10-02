import type { PermissionId } from "@open-inspect/shared/rbac";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { checkEnvironmentAccess } from "@open-inspect/shared";
import { resourceViewer } from "../authorization/resource-viewer";
import { EnvironmentStore } from "../db/environments";
import { json, type RequestContext } from "./shared";
import { authorizeTeamRepositories } from "./workspace-repository-authorization";

export interface SessionTarget {
  teamId: string | null;
  environmentId?: string | null;
  repositories?: readonly { owner: string; name: string; repoId?: number | null }[];
  enforceEnvironmentOwnership?: boolean;
  environmentOwnerTeamId?: string | null;
}

/** Preflight permissions with teamId: null; check team grants after resolving repository IDs. */
export async function authorizeSessionTarget(
  ctx: RequestContext,
  target: SessionTarget
): Promise<Response | null> {
  const sandbox = ctx.principal?.kind === "sandbox";
  const permission: PermissionId | null = target.environmentId
    ? "environments.use"
    : target.repositories?.length
      ? "repositories.use"
      : null;

  if (permission && (ctx.principal?.kind === "user" || ctx.principal?.kind === "service")) {
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
  if (target.environmentId && target.enforceEnvironmentOwnership) {
    const environment = await new EnvironmentStore(ctx.db).getById(target.environmentId);
    // Dangling environment provenance does not invalidate a sandbox's inherited clone context.
    if (!environment) {
      if (!sandbox) return json({ error: "Environment not found" }, 404);
      if (!target.repositories?.length) return null;
    } else if (!sandbox) {
      const access = checkEnvironmentAccess(
        await resourceViewer(ctx, environment.owner_team_id),
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
    const environmentOwnerTeamId = target.environmentOwnerTeamId ?? target.teamId;
    if (
      environment &&
      environment.owner_team_id !== null &&
      environment.owner_team_id !== environmentOwnerTeamId
    ) {
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

  return authorizeTeamRepositories(ctx, {
    teamId: target.teamId,
    repositories: (target.repositories ?? []).map((repository) => ({
      owner: repository.owner,
      name: repository.name,
      repoId: repository.repoId ?? null,
    })),
  });
}
