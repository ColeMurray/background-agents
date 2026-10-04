import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { MemoryScope } from "@open-inspect/shared/types/memories";
import type { AuthorizationService } from "./service";
import type { EnvironmentStore } from "../db/environments";
import type { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { TeamStore } from "../db/teams";
import { error } from "../http/responses";
import type { MemoryPartition } from "../memory/partition";
import { repositoryPartition } from "../memory/target";
import type { MemoryRecord, MemoryTarget } from "../memory/types";
import type { RepositoryAuthorizationTarget } from "../routes/workspace-repository-authorization";
import type { RepositoryAccessResult } from "../source-control/types";
import {
  ownedResourceAdmissionResponse,
  type OwnedResourceAdmissionOutcome,
} from "./owned-resource-admission";
import { AuthorizationError } from "./service";

/**
 * The memory access policy. Three questions, one module:
 * - can a human read/manage a scope ({@link MemoryManagementPolicy});
 * - can a session's principal read shared partitions right now ({@link SharedMemoryAccess}),
 *   asked when a session is created and again on every sandbox read, search, write, and boot;
 * - which agent writes remain valid at commit time (`db/session-memory-write-guard.ts`, which
 *   checks only facts about the writing session, never grant rules).
 *
 * Both classes receive their stores and admission checks through their constructors;
 * `memory-access-factory.ts` wires the D1-backed implementations for a request.
 */

/** Workspace/team repository-grant admission; returns a denial response, or null when allowed. */
export type RepositoryGrantCheck = (
  authorization: EffectiveAuthorization,
  repositories: readonly RepositoryAuthorizationTarget[],
  options?: { requireLead?: boolean }
) => Promise<Response | null>;

// ---------------------------------------------------------------------------
// Human management
// ---------------------------------------------------------------------------

export interface MemoryManagementGrant {
  partition: MemoryPartition;
  canManage: boolean;
}

/** Dependencies injected into MemoryManagementPolicy, bound to one admitted human request. */
export interface MemoryManagementPolicyDeps {
  /** The admitted principal's canonical user ID and effective authorization. */
  userId: string;
  authorization: EffectiveAuthorization | undefined;
  /** Resolve an installed repository to its stable identity; throws an HttpError when absent. */
  resolveRepository: (owner: string, name: string) => Promise<RepositoryAccessResult>;
  /** Environment ownership admission for the principal. */
  environmentAdmission: (
    environmentId: string,
    need: "read" | "manage"
  ) => Promise<OwnedResourceAdmissionOutcome>;
  repositoryGrants: RepositoryGrantCheck;
}

/**
 * Authorize human catalog access, resolve a scope to its partition, and compute management
 * capability. Personal records stay owner-only, even for administrators and collaborators.
 * Shared scopes use current repository grants or environment ownership; writes require
 * management authority, while reads return `canManage: false` rather than denying the catalog.
 */
export class MemoryManagementPolicy {
  constructor(private readonly deps: MemoryManagementPolicyDeps) {}

  /** Pass `record` for record-level requests so a partition mismatch conceals the record. */
  async authorize(
    scope: MemoryScope,
    mode: "read" | "write",
    record?: MemoryRecord
  ): Promise<MemoryManagementGrant | Response> {
    const permissions: readonly PermissionId[] = this.deps.authorization?.permissions ?? [];
    const granted = (canManage: boolean, partition: MemoryPartition) =>
      mode === "write" && !canManage
        ? error(`${scopeNoun(scope)} memory management permission required`, 403)
        : { partition, canManage };
    switch (scope.type) {
      case "personal": {
        const userId = this.deps.userId;
        if (record && !(record.partition.type === "personal" && record.partition.userId === userId))
          return error("Memory not found", 404);
        if (!permissions.includes("memories.manage_own"))
          return error("Personal memory permission required", 403);
        return { partition: { type: "personal", userId }, canManage: true };
      }
      case "environment": {
        const read = await this.deps.environmentAdmission(scope.environmentId, "read");
        if (read.kind !== "allowed") return ownedResourceAdmissionResponse(read);
        const manage = await this.deps.environmentAdmission(scope.environmentId, "manage");
        const canManage =
          manage.kind === "allowed" && permissions.includes("environments.settings.manage");
        return granted(canManage, { type: "environment", environmentId: scope.environmentId });
      }
      case "repository": {
        if (!permissions.includes("repositories.read") || !this.deps.authorization)
          return error("Repository read permission required", 403);
        const repo = await this.deps.resolveRepository(scope.repoOwner, scope.repoName);
        const partition = repositoryPartition(repo);
        // Names may be reused after deletion/rename; only the stable ID grants continuity.
        if (
          !partition ||
          (record &&
            !(record.partition.type === "repository" && record.partition.repoId === repo.repoId))
        )
          return error("Memory not found", 404);
        const repositories = [{ owner: repo.repoOwner, name: repo.repoName, repoId: repo.repoId }];
        const denied = await this.deps.repositoryGrants(this.deps.authorization, repositories);
        if (denied) return denied;
        const canManage =
          permissions.includes("repositories.settings.manage") &&
          !(await this.deps.repositoryGrants(this.deps.authorization, repositories, {
            requireLead: true,
          }));
        return granted(canManage, partition);
      }
      default: {
        const exhaustive: never = scope;
        throw new Error(`Unhandled memory scope: ${JSON.stringify(exhaustive)}`);
      }
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

// ---------------------------------------------------------------------------
// Session principals
// ---------------------------------------------------------------------------

/** Who a session acts for: its owning team, or (for workspace sessions) its owner. */
export interface MemoryPrincipal {
  userId: string | null;
  ownerTeamId: string | null;
}

/** Current shared-partition access for one principal. */
export interface PrincipalMemoryAccess {
  canRead(partitions: readonly MemoryPartition[]): Promise<boolean>;
}

/** Dependencies injected into SharedMemoryAccess. */
export interface SharedMemoryAccessDeps {
  teams: Pick<TeamStore, "isActive">;
  grants: Pick<TeamRepositoryGrantStore, "covers">;
  environments: Pick<EnvironmentStore, "getById">;
  authorization: Pick<AuthorizationService, "getEffectiveAuthorization">;
  repositoryGrants: RepositoryGrantCheck;
}

declare const authorizedMemoryTarget: unique symbol;
/** A session target whose shared partitions its principal may read; only {@link SharedMemoryAccess.authorizeTarget} makes one. */
export type AuthorizedMemoryTarget = Omit<MemoryTarget, "personalOwnerUserId"> & {
  /** The canonical session owner, whose personal memories may be included. */
  readonly userId: string | null;
  readonly [authorizedMemoryTarget]: true;
};

/**
 * Whether a session's principal can currently read shared memory partitions. A pinned manifest
 * or an issued sandbox token never freezes access: team activity, repository grants, owner
 * suspension, and environment ownership are evaluated on every request. Personal partitions are
 * governed by the session's pinned owner and opt-out instead, and always pass here.
 */
export class SharedMemoryAccess {
  constructor(private readonly deps: SharedMemoryAccessDeps) {}

  /** Load the principal's authorization once; the returned checker reads stores per call. */
  async forPrincipal(principal: MemoryPrincipal): Promise<PrincipalMemoryAccess> {
    const ownerAuthorization =
      !principal.ownerTeamId && principal.userId
        ? await this.ownerAuthorization(principal.userId)
        : null;
    return { canRead: (partitions) => this.canRead(principal, ownerAuthorization, partitions) };
  }

  /**
   * Narrow a new session's target to the shared partitions its principal may read. Memory never
   * decides whether a session can exist: repositories or an environment the principal cannot
   * read are simply omitted from the selection (session admission is `authorizeSessionTarget`'s
   * job).
   */
  async authorizeTarget(
    target: MemoryPrincipal & {
      repositories: readonly { repoOwner: string; repoName: string; repoId?: number | null }[];
      environmentId: string | null;
    }
  ): Promise<AuthorizedMemoryTarget> {
    const access = await this.forPrincipal(target);
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

  private async ownerAuthorization(userId: string): Promise<EffectiveAuthorization | null> {
    try {
      return await this.deps.authorization.getEffectiveAuthorization(userId);
    } catch (cause) {
      if (cause instanceof AuthorizationError) return null;
      throw cause;
    }
  }

  private async canRead(
    principal: MemoryPrincipal,
    ownerAuthorization: EffectiveAuthorization | null,
    partitions: readonly MemoryPartition[]
  ): Promise<boolean> {
    const repositories = partitions.flatMap((partition) =>
      partition.type === "repository"
        ? [{ owner: partition.repoOwner, name: partition.repoName, repoId: partition.repoId }]
        : []
    );
    if (principal.ownerTeamId) {
      if (!(await this.deps.teams.isActive(principal.ownerTeamId))) return false;
      if (
        !(await this.deps.grants.covers(
          principal.ownerTeamId,
          repositories.map((repo) => repo.repoId)
        ))
      )
        return false;
    } else {
      if (!ownerAuthorization || ownerAuthorization.suspendedAt !== null) return false;
      if (await this.deps.repositoryGrants(ownerAuthorization, repositories)) return false;
    }
    for (const partition of partitions) {
      if (partition.type !== "environment") continue;
      const environment = await this.deps.environments.getById(partition.environmentId);
      if (
        !environment ||
        (environment.owner_team_id && environment.owner_team_id !== principal.ownerTeamId)
      )
        return false;
    }
    return true;
  }
}
