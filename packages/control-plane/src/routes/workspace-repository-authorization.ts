import { isWorkspaceAdmin } from "@open-inspect/shared/rbac";
import { resourceViewer } from "../authorization/resource-viewer";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { json, type RequestContext } from "./shared";
import { missingTeamRepository } from "./session-team-grants";

export interface RepositoryAuthorizationTarget {
  owner: string;
  name: string;
  repoId: number | null;
}

function deniedRepository(repository: RepositoryAuthorizationTarget): Response {
  return json(
    {
      error: "Repository grant required",
      code: "repository_grant_required",
      reason_code: "repository_grant_required",
      repository: `${repository.owner}/${repository.name}`,
    },
    403
  );
}

/** Grant-only check; callers retain their existing permission and membership admission. */
export async function authorizeTeamRepositories(
  ctx: RequestContext,
  target: { teamId: string | null; repositories: readonly RepositoryAuthorizationTarget[] }
): Promise<Response | null> {
  if (target.teamId === null) return null;
  if (!(await new TeamStore(ctx.db).isActive(target.teamId))) {
    return json({ error: "Team is not active", code: "team_not_active" }, 403);
  }
  const missing = await missingTeamRepository(
    ctx.db,
    target.teamId,
    target.repositories.map((repository) => ({
      repoOwner: repository.owner,
      repoName: repository.name,
      repoId: repository.repoId,
    }))
  );
  if (!missing) return null;
  return json(
    {
      error: "Target team lacks repository grant",
      code: "target_team_missing_grant",
      repository: `${missing.repoOwner}/${missing.repoName}`,
    },
    409
  );
}

/** Unowned repositories stay workspace-level; any granting team may authorize its members. */
export async function authorizeWorkspaceRepositories(
  ctx: RequestContext,
  target: {
    repositories: readonly RepositoryAuthorizationTarget[];
    requireLead?: boolean;
  }
): Promise<Response | null> {
  if (target.repositories.length === 0) return null;
  const authorization = ctx.authorization;
  if (!authorization) {
    return json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503);
  }
  const roleKey = authorization.role.key;
  if (isWorkspaceAdmin(roleKey)) return null;

  const store = new TeamRepositoryGrantStore(ctx.db);
  const teams = new TeamStore(ctx.db);
  for (const repository of target.repositories) {
    const repoId = repository.repoId;
    if (repoId === null || !Number.isSafeInteger(repoId) || repoId <= 0)
      return deniedRepository(repository);
    const owners = await store.listTeamsForRepository(repoId);
    if (owners.length === 0) continue;
    const viewer = await resourceViewer(ctx);
    if (viewer.kind !== "user") throw new Error("Missing request authorization");
    const memberships = viewer.memberships;
    let allowed = false;
    for (const teamId of owners) {
      if (target.requireLead ? memberships.get(teamId) !== "lead" : !memberships.has(teamId))
        continue;
      if (await teams.isActive(teamId)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return deniedRepository(repository);
  }
  return null;
}
