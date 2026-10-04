import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { MemoryScope, MemoryScopeType } from "@open-inspect/shared/types/memories";
import type { AuthorizationService } from "./service";
import type { EnvironmentStore } from "../db/environments";
import type { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { TeamStore } from "../db/teams";
import { samePartition, type MemoryPartition } from "../memory/partition";
import { repositoryPartition } from "../memory/target";
import type { MemoryRecord, MemoryTarget } from "../memory/types";
import type { InstalledRepositoryResolver } from "../routes/shared";
import {
  REPOSITORY_GRANT_REQUIRED,
  type RepositoryAuthorizationTarget,
  type RepositoryGrantAuthorizer,
} from "../routes/workspace-repository-authorization";
import type {
  EnvironmentAdmissionEvaluator,
  OwnedResourceAdmissionOutcome,
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

/** Workspace/team repository-grant admission evaluated as a given principal. */
export type RepositoryGrants = Pick<RepositoryGrantAuthorizer, "ungrantedRepository">;

// ---------------------------------------------------------------------------
// Human management
// ---------------------------------------------------------------------------

/**
 * Why a principal may not use a memory scope. Transport-neutral: routes translate `reason` to a
 * status code and the remaining fields to the response body.
 */
export interface MemoryAccessDenial {
  reason: "not_found" | "forbidden";
  message: string;
  /** Stable machine-readable codes from the underlying admission check, when it has them. */
  code?: string;
  reasonCode?: string;
  /** The `owner/name` of the repository that failed a grant check. */
  repository?: string;
}

export type MemoryManagementDecision =
  | { kind: "granted"; partition: MemoryPartition; canManage: boolean }
  | { kind: "denied"; denial: MemoryAccessDenial };

/** Dependencies injected into MemoryManagementPolicy, bound to one admitted human request. */
export interface MemoryManagementPolicyDeps {
  /** The admitted principal's canonical user ID and effective authorization. */
  userId: string;
  authorization: EffectiveAuthorization | undefined;
  /** Installed-repository resolution to stable identities. */
  repositories: Pick<InstalledRepositoryResolver, "resolve">;
  /** Environment ownership admission for the principal. */
  environments: Pick<EnvironmentAdmissionEvaluator, "evaluate">;
  repositoryGrants: RepositoryGrants;
}

const SCOPE_LABELS: Record<MemoryScopeType, string> = {
  personal: "Personal",
  repository: "Repository",
  environment: "Environment",
};

const granted = (partition: MemoryPartition, canManage: boolean): MemoryManagementDecision => ({
  kind: "granted",
  partition,
  canManage,
});
const denied = (denial: MemoryAccessDenial): MemoryManagementDecision => ({
  kind: "denied",
  denial,
});
const NOT_FOUND = denied({ reason: "not_found", message: "Memory not found" });

/** A record-level request conceals any record outside the requested partition. */
function conceals(record: MemoryRecord | undefined, partition: MemoryPartition): boolean {
  return record !== undefined && !samePartition(record.partition, partition);
}

function admissionDenial(
  outcome: Exclude<OwnedResourceAdmissionOutcome, { kind: "allowed" }>
): MemoryManagementDecision {
  const { response } = outcome;
  return denied({
    reason: outcome.status === 404 ? "not_found" : "forbidden",
    message: response.error,
    ...("code" in response ? { code: response.code, reasonCode: response.reason_code } : {}),
  });
}

function grantDenial(repository: RepositoryAuthorizationTarget): MemoryManagementDecision {
  return denied({
    reason: "forbidden",
    message: REPOSITORY_GRANT_REQUIRED.message,
    code: REPOSITORY_GRANT_REQUIRED.code,
    reasonCode: REPOSITORY_GRANT_REQUIRED.code,
    repository: `${repository.owner}/${repository.name}`,
  });
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
  ): Promise<MemoryManagementDecision> {
    const decision = await this.scopeAccess(scope, record);
    if (decision.kind === "denied" || mode === "read" || decision.canManage) return decision;
    return denied({
      reason: "forbidden",
      message: `${SCOPE_LABELS[scope.type]} memory management permission required`,
    });
  }

  /** The scope's partition and the principal's read/manage access to it. */
  private scopeAccess(scope: MemoryScope, record?: MemoryRecord) {
    switch (scope.type) {
      case "personal":
        return this.personalAccess(record);
      case "environment":
        return this.environmentAccess(scope.environmentId, record);
      case "repository":
        return this.repositoryAccess(scope.repoOwner, scope.repoName, record);
      default: {
        const exhaustive: never = scope;
        throw new Error(`Unhandled memory scope: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Always the caller's own store; another owner's record is indistinguishable from none. */
  private async personalAccess(record?: MemoryRecord): Promise<MemoryManagementDecision> {
    const partition: MemoryPartition = { type: "personal", userId: this.deps.userId };
    if (conceals(record, partition)) return NOT_FOUND;
    if (!this.can("memories.manage_own"))
      return denied({ reason: "forbidden", message: "Personal memory permission required" });
    return granted(partition, true);
  }

  private async environmentAccess(
    environmentId: string,
    record?: MemoryRecord
  ): Promise<MemoryManagementDecision> {
    const partition: MemoryPartition = { type: "environment", environmentId };
    if (conceals(record, partition)) return NOT_FOUND;
    const read = await this.deps.environments.evaluate(environmentId, "read");
    if (read.kind !== "allowed") return admissionDenial(read);
    const manage = await this.deps.environments.evaluate(environmentId, "manage");
    return granted(
      partition,
      manage.kind === "allowed" && this.can("environments.settings.manage")
    );
  }

  /** Names may be reused after deletion or rename; only the stable repository ID matches. */
  private async repositoryAccess(
    owner: string,
    name: string,
    record?: MemoryRecord
  ): Promise<MemoryManagementDecision> {
    const authorization = this.deps.authorization;
    if (!authorization || !this.can("repositories.read"))
      return denied({ reason: "forbidden", message: "Repository read permission required" });
    const repo = await this.deps.repositories.resolve(owner, name);
    const partition = repositoryPartition(repo);
    if (!partition || conceals(record, partition)) return NOT_FOUND;
    const target = [{ owner: repo.repoOwner, name: repo.repoName, repoId: repo.repoId }];
    const ungranted = await this.deps.repositoryGrants.ungrantedRepository(authorization, target);
    if (ungranted) return grantDenial(ungranted);
    const canManage =
      this.can("repositories.settings.manage") &&
      !(await this.deps.repositoryGrants.ungrantedRepository(authorization, target, {
        requireLead: true,
      }));
    return granted(partition, canManage);
  }

  private can(permission: PermissionId): boolean {
    return this.deps.authorization?.permissions.includes(permission) ?? false;
  }
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
  repositoryGrants: RepositoryGrants;
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
      if (await this.deps.repositoryGrants.ungrantedRepository(ownerAuthorization, repositories))
        return false;
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
