import type { MemoryScope } from "@open-inspect/shared/types/memories";
import { EnvironmentStore } from "../db/environments";
import { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import { TeamStore } from "../db/teams";
import { error } from "../http/responses";
import type { RequestContext } from "../http/request-context";
import { createLogger } from "../logger";
import type { MemoryPartition } from "../memory/partition";
import { repositoryPartition } from "../memory/target";
import type { MemoryRecord, MemoryTarget } from "../memory/types";
import { resolveRepoOrError, type UserRouteContext } from "../routes/shared";
import { authorizeWorkspaceRepositories } from "../routes/workspace-repository-authorization";
import {
  evaluateEnvironmentAdmission,
  ownedResourceAdmissionResponse,
} from "./owned-resource-admission";
import { AuthorizationError, AuthorizationService } from "./service";

const logger = createLogger("memories");

/**
 * The memory access policy. Three questions, one module:
 * - can a human read/manage a scope ({@link authorizeMemoryManagement});
 * - can a session's owner read shared partitions right now ({@link SharedMemoryAccess}), asked
 *   when a session is created and again on every sandbox read, search, write, and boot;
 * - which agent writes remain valid at commit time (`db/session-memory-write-guard.ts`, which
 *   checks only facts about the writing session, never grant rules).
 */

export interface MemoryManagementAccess {
  partition: MemoryPartition;
  canManage: boolean;
}

/**
 * Authorize human catalog access, resolve the scope to its partition, and compute management
 * capability. Personal records stay owner-only, even for administrators and collaborators.
 * Shared scopes use current repository grants or environment ownership; writes require
 * management authority, while reads return `canManage: false` rather than denying the catalog.
 * Pass `record` for record-level requests so a partition mismatch conceals the record.
 */
export async function authorizeMemoryManagement(
  ctx: UserRouteContext,
  env: Parameters<typeof resolveRepoOrError>[0],
  scope: MemoryScope,
  mode: "read" | "write",
  record?: MemoryRecord
): Promise<MemoryManagementAccess | Response> {
  const permissions = ctx.authorization?.permissions ?? [];
  const granted = (canManage: boolean, partition: MemoryPartition) =>
    mode === "write" && !canManage
      ? error(`${scopeNoun(scope)} memory management permission required`, 403)
      : { partition, canManage };
  switch (scope.type) {
    case "personal": {
      if (
        record &&
        !(record.partition.type === "personal" && record.partition.userId === ctx.principal.userId)
      )
        return error("Memory not found", 404);
      if (!permissions.includes("memories.manage_own"))
        return error("Personal memory permission required", 403);
      return { partition: { type: "personal", userId: ctx.principal.userId }, canManage: true };
    }
    case "environment": {
      const read = await evaluateEnvironmentAdmission(ctx, scope.environmentId, "read");
      if (read.kind !== "allowed") return ownedResourceAdmissionResponse(read);
      const manage = await evaluateEnvironmentAdmission(ctx, scope.environmentId, "manage");
      const canManage =
        manage.kind === "allowed" && permissions.includes("environments.settings.manage");
      return granted(canManage, { type: "environment", environmentId: scope.environmentId });
    }
    case "repository": {
      if (!permissions.includes("repositories.read"))
        return error("Repository read permission required", 403);
      const repo = await resolveRepoOrError(env, scope.repoOwner, scope.repoName, ctx, logger);
      const partition = repositoryPartition(repo);
      // Names may be reused after deletion/rename; only the stable ID grants continuity.
      if (
        !partition ||
        (record &&
          !(record.partition.type === "repository" && record.partition.repoId === repo.repoId))
      )
        return error("Memory not found", 404);
      const repositories = [{ owner: repo.repoOwner, name: repo.repoName, repoId: repo.repoId }];
      const denied = await authorizeWorkspaceRepositories(ctx, { repositories });
      if (denied) return denied;
      const canManage =
        permissions.includes("repositories.settings.manage") &&
        !(await authorizeWorkspaceRepositories(ctx, { repositories, requireLead: true }));
      return granted(canManage, partition);
    }
    default: {
      const exhaustive: never = scope;
      throw new Error(`Unhandled memory scope: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function scopeNoun(scope: MemoryScope): string {
  return scope.type === "repository"
    ? "Repository"
    : scope.type === "environment"
      ? "Environment"
      : "Personal";
}

/** Who a session acts for: its owning team, or (for workspace sessions) its owner. */
export interface MemoryPrincipal {
  userId: string | null;
  ownerTeamId: string | null;
}

/**
 * Whether a session's principal can currently read shared memory partitions. A pinned manifest
 * or an issued sandbox token never freezes access: team activity, repository grants, owner
 * suspension, and environment ownership are evaluated on every request. Personal partitions are
 * governed by the session's pinned owner and opt-out instead, and always pass here.
 */
export class SharedMemoryAccess {
  private constructor(
    private readonly ctx: RequestContext,
    private readonly principal: MemoryPrincipal,
    private readonly ownerAuthorization: RequestContext["authorization"] | null
  ) {}

  static async load(ctx: RequestContext, principal: MemoryPrincipal): Promise<SharedMemoryAccess> {
    let ownerAuthorization: RequestContext["authorization"] | null = null;
    if (!principal.ownerTeamId && principal.userId) {
      try {
        ownerAuthorization = await new AuthorizationService(ctx.db).getEffectiveAuthorization(
          principal.userId
        );
      } catch (cause) {
        if (!(cause instanceof AuthorizationError)) throw cause;
      }
    }
    return new SharedMemoryAccess(ctx, principal, ownerAuthorization);
  }

  async canRead(partitions: readonly MemoryPartition[]): Promise<boolean> {
    const repositories = partitions.flatMap((partition) =>
      partition.type === "repository"
        ? [{ owner: partition.repoOwner, name: partition.repoName, repoId: partition.repoId }]
        : []
    );
    if (this.principal.ownerTeamId) {
      if (!(await new TeamStore(this.ctx.db).isActive(this.principal.ownerTeamId))) return false;
      if (
        !(await new TeamRepositoryGrantStore(this.ctx.db).covers(
          this.principal.ownerTeamId,
          repositories.map((repo) => repo.repoId)
        ))
      )
        return false;
    } else {
      const authorization = this.ownerAuthorization;
      if (!authorization || authorization.suspendedAt !== null) return false;
      if (
        await authorizeWorkspaceRepositories(
          { ...this.ctx, authorization, sessionMemberships: undefined },
          { repositories }
        )
      )
        return false;
    }
    for (const partition of partitions) {
      if (partition.type !== "environment") continue;
      const environment = await new EnvironmentStore(this.ctx.db).getById(partition.environmentId);
      if (
        !environment ||
        (environment.owner_team_id && environment.owner_team_id !== this.principal.ownerTeamId)
      )
        return false;
    }
    return true;
  }
}

declare const authorizedMemoryTarget: unique symbol;
/** A session target whose shared partitions its principal may read; only {@link authorizeMemoryTarget} makes one. */
export type AuthorizedMemoryTarget = Omit<MemoryTarget, "personalOwnerUserId"> & {
  /** The canonical session owner, whose personal memories may be included. */
  readonly userId: string | null;
  readonly [authorizedMemoryTarget]: true;
};

/**
 * Narrow a new session's target to the shared partitions its principal may read. Memory never
 * decides whether a session can exist: repositories or an environment the principal cannot read
 * are simply omitted from the selection (session admission is `authorizeSessionTarget`'s job).
 */
export async function authorizeMemoryTarget(
  ctx: RequestContext,
  target: MemoryPrincipal & {
    repositories: readonly { repoOwner: string; repoName: string; repoId?: number | null }[];
    environmentId: string | null;
  }
): Promise<AuthorizedMemoryTarget> {
  const access = await SharedMemoryAccess.load(ctx, target);
  const repositories: { repoOwner: string; repoName: string; repoId: number }[] = [];
  for (const repo of target.repositories) {
    const partition = repositoryPartition({ ...repo, repoId: repo.repoId ?? null });
    if (partition && (await access.canRead([partition])))
      repositories.push({
        repoOwner: repo.repoOwner,
        repoName: repo.repoName,
        repoId: partition.repoId,
      });
  }
  const environmentId =
    target.environmentId &&
    (await access.canRead([{ type: "environment", environmentId: target.environmentId }]))
      ? target.environmentId
      : null;
  return {
    userId: target.userId,
    repositories,
    environmentId,
  } as unknown as AuthorizedMemoryTarget;
}
