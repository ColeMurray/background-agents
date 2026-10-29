import { EnvironmentStore } from "../db/environments";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import { InstalledRepositoryResolver, type UserRouteContext } from "../routes/shared";
import { RepositoryGrantAuthorizer } from "../routes/workspace-repository-authorization";
import type { Env } from "../types";
import { MemoryManagementPolicy, SessionMemoryAccessPolicy } from "./memory-access";
import { EnvironmentAdmissionEvaluator } from "./owned-resource-admission";
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
    repositories: new InstalledRepositoryResolver(env, ctx, logger),
    environments: new EnvironmentAdmissionEvaluator(ctx, new EnvironmentStore(ctx.db)),
    repositoryGrants: new RepositoryGrantAuthorizer(
      ctx,
      new TeamRepositoryGrantStore(ctx.db),
      new TeamStore(ctx.db)
    ),
  });
}

/** Wire session-principal access checks to D1 for one request. */
export function createSessionMemoryAccessPolicy(ctx: RequestContext): SessionMemoryAccessPolicy {
  const grants = new TeamRepositoryGrantStore(ctx.db);
  const teams = new TeamStore(ctx.db);
  return new SessionMemoryAccessPolicy({
    teams,
    grants,
    environments: new EnvironmentStore(ctx.db),
    authorization: new AuthorizationService(ctx.db),
    repositoryGrants: new RepositoryGrantAuthorizer(ctx, grants, teams),
  });
}
