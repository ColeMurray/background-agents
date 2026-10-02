import type { PermissionId } from "@open-inspect/shared/rbac";
import { isSelfActingPrincipal } from "../auth/principal";
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

  // An access token is its owner, so it faces the checks that owner would: skipping them would
  // let the credential aim an automation at repositories and environments the user may not use.
  if (permission && (isSelfActingPrincipal(ctx.principal) || ctx.principal?.kind === "service")) {
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
 * Inherited targets (a child's parent environment) are provenance rather than a new choice, so
 * they tolerate an environment that has since been deleted; `EnvironmentStore.delete` leaves
 * sessions' environment IDs dangling. Sandboxes also skip use admission.
 */
export async function authorizeEnvironmentTarget(
  ctx: RequestContext,
  target: { environmentId: string; ownerTeamId: string | null; inherited?: boolean }
): Promise<Response | null> {
  const sandbox = ctx.principal?.kind === "sandbox";
  if (sandbox || target.inherited) {
    const environment = await new EnvironmentStore(ctx.db).getById(target.environmentId);
    if (!environment) return null;
    if (sandbox) return environmentTeamMismatch(environment, target.ownerTeamId);
  }
  const admission = await evaluateEnvironmentAdmission(ctx, target.environmentId, "use");
  if (admission.kind !== "allowed") return ownedResourceAdmissionResponse(admission);
  return environmentTeamMismatch(admission.admission.environment, target.ownerTeamId);
}

function environmentTeamMismatch(
  environment: EnvironmentRow,
  ownerTeamId: string | null
): Response | null {
  if (environment.owner_team_id === null || environment.owner_team_id === ownerTeamId) return null;
  return json(
    {
      error: "Environment must belong to the session's owner team",
      code: "environment_team_mismatch",
      reason_code: "environment_team_mismatch",
    },
    409
  );
}
