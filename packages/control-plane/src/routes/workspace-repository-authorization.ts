import { isWorkspaceAdmin, type EffectiveAuthorization } from "@open-inspect/shared/rbac";
import { TeamMembershipStore } from "../db/team-memberships";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { json, type RequestContext } from "./shared";
import { missingTeamRepository } from "./session-team-grants";

export interface RepositoryAuthorizationTarget {
  owner: string;
  name: string;
  repoId: number | null;
}

export const REPOSITORY_GRANT_REQUIRED = {
  message: "Repository grant required",
  code: "repository_grant_required",
} as const;

function deniedRepository(repository: RepositoryAuthorizationTarget): Response {
  return json(
    {
      error: REPOSITORY_GRANT_REQUIRED.message,
      code: REPOSITORY_GRANT_REQUIRED.code,
      reason_code: REPOSITORY_GRANT_REQUIRED.code,
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

/**
 * The first repository the principal lacks a grant for, or null when all are allowed. Unowned
 * repositories stay workspace-level; any granting team may authorize its members. Memberships
 * are cached on `ctx` for the rest of the request.
 */
async function findUngrantedRepository(
  ctx: RequestContext,
  authorization: EffectiveAuthorization,
  target: { repositories: readonly RepositoryAuthorizationTarget[]; requireLead?: boolean }
): Promise<RepositoryAuthorizationTarget | null> {
  if (isWorkspaceAdmin(authorization.role.key)) return null;
  const store = new TeamRepositoryGrantStore(ctx.db);
  const teams = new TeamStore(ctx.db);
  for (const repository of target.repositories) {
    const repoId = repository.repoId;
    if (repoId === null || !Number.isSafeInteger(repoId) || repoId <= 0) return repository;
    const owners = await store.listTeamsForRepository(repoId);
    if (owners.length === 0) continue;
    const memberships = (ctx.sessionMemberships ??= await new TeamMembershipStore(
      ctx.db
    ).listForUser(authorization.userId));
    let allowed = false;
    for (const teamId of owners) {
      if (target.requireLead ? memberships.get(teamId) !== "lead" : !memberships.has(teamId))
        continue;
      if (await teams.isActive(teamId)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return repository;
  }
  return null;
}

/** Route admission over {@link findUngrantedRepository}: a denial response, or null when allowed. */
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
  const ungranted = await findUngrantedRepository(ctx, authorization, target);
  return ungranted ? deniedRepository(ungranted) : null;
}

/**
 * Workspace repository-grant admission evaluated as a given principal, for policies that check
 * someone other than (or in addition to) the caller. The request's cached team memberships are
 * reused only when the principal is the caller.
 */
export class RepositoryGrantAuthorizer {
  constructor(private readonly ctx: RequestContext) {}

  /** The first repository `authorization` lacks a grant for, or null when all are allowed. */
  ungrantedRepository(
    authorization: EffectiveAuthorization,
    repositories: readonly RepositoryAuthorizationTarget[],
    options: { requireLead?: boolean } = {}
  ): Promise<RepositoryAuthorizationTarget | null> {
    const sameUser = authorization.userId === this.ctx.authorization?.userId;
    return findUngrantedRepository(
      {
        ...this.ctx,
        authorization,
        sessionMemberships: sameUser ? this.ctx.sessionMemberships : undefined,
      },
      authorization,
      { repositories, ...options }
    );
  }
}
