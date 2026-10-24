import { EnvironmentStore } from "../db/environments";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { createLogger } from "../logger";
import { InstalledRepositoryResolver, type UserRouteContext } from "../routes/shared";
import {
  RepositoryGrantAuthorizer,
  type RepositoryGrantContext,
} from "../routes/workspace-repository-authorization";
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
    environments: new EnvironmentAdmissionEvaluator(ctx),
    repositoryGrants: new RepositoryGrantAuthorizer(ctx),
  });
}

/**
 * Wire session-principal access checks to D1 for one request.
 *
 * The policy reads the global store and nothing else, so the session runtime
 * wires the same policy over its own D1 binding without an HTTP request
 * context. The repository-grant check inside it resolves the session's
 * principal from the store, exactly as it does for a sandbox request.
 */
export function createSessionMemoryAccessPolicy(
  ctx: RepositoryGrantContext
): SessionMemoryAccessPolicy {
  return new SessionMemoryAccessPolicy({
    teams: new TeamStore(ctx.db),
    grants: new TeamRepositoryGrantStore(ctx.db),
    environments: new EnvironmentStore(ctx.db),
    authorization: new AuthorizationService(ctx.db),
    repositoryGrants: new RepositoryGrantAuthorizer(ctx),
  });
}
