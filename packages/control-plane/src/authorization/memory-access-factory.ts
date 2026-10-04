import { EnvironmentStore } from "../db/environments";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import { resolveRepoOrError, type UserRouteContext } from "../routes/shared";
import { authorizeWorkspaceRepositories } from "../routes/workspace-repository-authorization";
import type { Env } from "../types";
import { MemoryManagementPolicy, SharedMemoryAccess } from "./memory-access";
import { evaluateEnvironmentAdmission } from "./owned-resource-admission";
import { AuthorizationService } from "./service";

const logger = createLogger("memories");

/** Wire the management policy to D1, SCM resolution, and admission for one human request. */
export function createMemoryManagementPolicy(
  ctx: UserRouteContext,
  env: Env
): MemoryManagementPolicy {
  return new MemoryManagementPolicy({
    userId: ctx.principal.userId,
    authorization: ctx.authorization,
    resolveRepository: (owner, name) => resolveRepoOrError(env, owner, name, ctx, logger),
    environmentAdmission: (environmentId, need) =>
      evaluateEnvironmentAdmission(ctx, environmentId, need),
    // The principal's own authorization, so the request's membership cache stays valid.
    repositoryGrants: (authorization, repositories, options) =>
      authorizeWorkspaceRepositories({ ...ctx, authorization }, { repositories, ...options }),
  });
}

/** Wire shared-partition access checks to D1 for one request. */
export function createSharedMemoryAccess(ctx: RequestContext): SharedMemoryAccess {
  return new SharedMemoryAccess({
    teams: new TeamStore(ctx.db),
    grants: new TeamRepositoryGrantStore(ctx.db),
    environments: new EnvironmentStore(ctx.db),
    authorization: new AuthorizationService(ctx.db),
    // Evaluated as the session principal, never the caller: drop any cached memberships.
    repositoryGrants: (authorization, repositories, options) =>
      authorizeWorkspaceRepositories(
        { ...ctx, authorization, sessionMemberships: undefined },
        { repositories, ...options }
      ),
  });
}
