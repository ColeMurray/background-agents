import type { PermissionId } from "@open-inspect/shared/rbac";
import {
  evaluateEnvironmentAdmission,
  ownedResourceAdmissionResponse,
} from "../authorization/owned-resource-admission";
import { serviceAllowsPermission } from "../authorization/service-permissions";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { json, type RequestContext } from "./shared";
import { authorizeTeamRepositories } from "./workspace-repository-authorization";

export interface SessionTarget {
  /** Team whose repository grants are checked; null during preflight, before IDs resolve. */
  teamId: string | null;
  environmentId?: string | null;
  repositories?: readonly { owner: string; name: string; repoId?: number | null }[];
}

/**
 * Permission and repository-grant checks for a session or automation target. Preflight with
 * teamId: null; check team grants after resolving repository IDs. This does not admit the
 * environment resource itself: launches must also call {@link authorizeEnvironmentTarget}.
 */
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

/**
 * Admit the environment a session launches with and bind its ownership to the session: the
 * caller must be able to use it, and a team environment must belong to the session's team.
 * Sandboxes inherit their parent's environment, so they skip use admission and tolerate
 * dangling provenance.
 */
export async function authorizeEnvironmentTarget(
  ctx: RequestContext,
  target: { environmentId: string; ownerTeamId: string | null }
): Promise<Response | null> {
  let environment: EnvironmentRow | null;
  if (ctx.principal?.kind === "sandbox") {
    environment = await new EnvironmentStore(ctx.db).getById(target.environmentId);
    if (!environment) return null;
  } else {
    const admission = await evaluateEnvironmentAdmission(ctx, target.environmentId, "use");
    if (admission.kind !== "allowed") return ownedResourceAdmissionResponse(admission);
    environment = ctx.environmentAdmission!.environment;
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
  return null;
}
