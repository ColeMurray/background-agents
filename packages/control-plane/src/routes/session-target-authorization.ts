import type { PermissionId } from "@open-inspect/shared/rbac";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { json, type RequestContext } from "./shared";
import { authorizeTeamRepositories } from "./workspace-repository-authorization";

export interface SessionTarget {
  teamId: string | null;
  environmentId?: string | null;
  repositories?: readonly { owner: string; name: string; repoId?: number | null }[];
}

/** Preflight permissions with teamId: null; check team grants after resolving repository IDs. */
export async function authorizeSessionTarget(
  ctx: RequestContext,
  target: SessionTarget
): Promise<Response | null> {
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

  return authorizeTeamRepositories(ctx, {
    teamId: target.teamId,
    repositories: (target.repositories ?? []).map((repository) => ({
      owner: repository.owner,
      name: repository.name,
      repoId: repository.repoId ?? null,
    })),
  });
}
