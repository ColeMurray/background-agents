import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { MemoryScope, MemoryScopeType } from "@open-inspect/shared/types/memories";
import type { EnvironmentStore } from "../db/environments";
import type { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { TeamStore } from "../db/teams";
import type { MemoryPartition } from "../memory/partition";
import { MEMORY_NOT_FOUND, unhandled } from "../memory/errors";
import { repositoryPartition } from "../memory/sources";
import type { MemoryRecord, SessionPrincipal } from "../memory/types";
import type { InstalledRepositoryResolver } from "../routes/shared";
import {
  REPOSITORY_GRANT_REQUIRED,
  type RepositoryGrantAuthorizer,
} from "../routes/workspace-repository-authorization";
import type {
  EnvironmentAdmissionEvaluator,
  OwnedResourceAdmissionOutcome,
} from "./owned-resource-admission";
import { AuthorizationError, type AuthorizationService } from "./service";

/**
 * The memory access policy. Three questions, one module:
 * - can a human read/manage a scope ({@link MemoryManagementPolicy});
 * - can a session's principal read memory partitions right now ({@link SessionMemoryAccessPolicy}),
 *   asked when a session's memory is selected and again on every sandbox read, search, write,
 *   and boot;
 * - which agent writes remain valid at commit time (`db/session-memory-write-guard.ts`, which
 *   checks only facts about the writing session and its owner, never repository or team grants).
 *
 * Both classes receive their stores and admission checks through their constructors;
 * `memory-access-factory.ts` wires the D1-backed implementations for a request.
 */

type RepositoryPartition = Extract<MemoryPartition, { type: "repository" }>;

/** Grant checks over repository partitions; satisfied by `RepositoryGrantAuthorizer`. */
export interface RepositoryGrants {
  ungrantedRepository(
    authorization: EffectiveAuthorization,
    repositories: readonly RepositoryPartition[],
    options?: { requireLead?: boolean }
  ): Promise<RepositoryPartition | null>;
}

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
  | {
      kind: "granted";
      partition: MemoryPartition;
      /** How the granted scope is displayed (resolved names for repositories). */
      scope: MemoryScope;
      canManage: boolean;
    }
  | { kind: "denied"; denial: MemoryAccessDenial };

/** Dependencies injected into MemoryManagementPolicy, bound to one admitted human request. */
export interface MemoryManagementPolicyDeps {
  /** The admitted principal's canonical user ID and effective authorization. */
  userId: string;
  authorization: EffectiveAuthorization | undefined;
  /** Installed-repository resolution to stable identities. */
  repositories: Pick<InstalledRepositoryResolver, "resolve">;
  /** Environment ownership admission for the principal. */
  environments: Pick<EnvironmentAdmissionEvaluator, "evaluate" | "preload">;
  repositoryGrants: RepositoryGrants & Pick<RepositoryGrantAuthorizer, "preload">;
}

const SCOPE_LABELS: Record<MemoryScopeType, string> = {
  personal: "Personal",
  repository: "Repository",
  environment: "Environment",
};

const granted = (
  partition: MemoryPartition,
  scope: MemoryScope,
  canManage: boolean
): MemoryManagementDecision => ({ kind: "granted", partition, scope, canManage });
const denied = (denial: MemoryAccessDenial): DeniedDecision => ({
  kind: "denied",
  denial,
});
type DeniedDecision = Extract<MemoryManagementDecision, { kind: "denied" }>;
/** Read access to a partition and whether the principal may also manage it. */
type PartitionAccess = { kind: "granted"; canManage: boolean } | DeniedDecision;
/** A shared partition the principal may read, from {@link MemoryManagementPolicy.authorizeSharedCatalog}. */
export interface SharedCatalogGrant {
  partition: MemoryPartition;
  canManage: boolean;
}
const NOT_FOUND: DeniedDecision = {
  kind: "denied",
  denial: { reason: "not_found", message: MEMORY_NOT_FOUND },
};
const REPOSITORY_READ_REQUIRED: DeniedDecision = {
  kind: "denied",
  denial: { reason: "forbidden", message: "Repository read permission required" },
};

function admissionDenial(
  outcome: Exclude<OwnedResourceAdmissionOutcome, { kind: "allowed" }>
): DeniedDecision {
  const { response } = outcome;
  return denied({
    reason: outcome.status === 404 ? "not_found" : "forbidden",
    message: response.error,
    ...("code" in response ? { code: response.code, reasonCode: response.reason_code } : {}),
  });
}

function grantDenial(repository: string): DeniedDecision {
  return denied({
    reason: "forbidden",
    message: REPOSITORY_GRANT_REQUIRED.message,
    code: REPOSITORY_GRANT_REQUIRED.code,
    reasonCode: REPOSITORY_GRANT_REQUIRED.code,
    repository,
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

  /** Admit shared catalog identities in bulk using one request-local admission snapshot. */
  async authorizeSharedCatalog(
    partitions: readonly MemoryPartition[]
  ): Promise<SharedCatalogGrant[]> {
    const shared = partitions.filter((partition) => partition.type !== "personal");
    await this.preload(shared);
    const admitted: SharedCatalogGrant[] = [];
    for (const partition of shared) {
      // Denials are dropped, so no display scope is needed to describe them.
      const access = await this.partitionAccess(partition);
      if (access.kind === "granted") admitted.push({ partition, canManage: access.canManage });
    }
    return admitted;
  }

  /** Authorize a request about a scope a person named: listing, creating, or previewing. */
  async authorizeScope(
    scope: MemoryScope,
    mode: "read" | "write"
  ): Promise<MemoryManagementDecision> {
    const resolved = await this.resolvePartition(scope);
    return resolved.kind === "denied"
      ? resolved
      : this.authorizePartition(resolved.partition, resolved.scope, mode);
  }

  /**
   * Authorize a request about an existing record by its stored partition identity, never its
   * display names: a renamed repository's memories stay manageable, and a repository that reuses
   * a name gains nothing. Another owner's personal record is indistinguishable from none.
   */
  authorizeRecord(
    record: Pick<MemoryRecord, "partition" | "scope">,
    mode: "read" | "write"
  ): Promise<MemoryManagementDecision> {
    return this.authorizePartition(record.partition, record.scope, mode);
  }

  /** {@link authorizeRecord} for many records over one request-local admission snapshot. */
  async authorizeRecords(
    records: readonly Pick<MemoryRecord, "partition" | "scope">[],
    mode: "read" | "write"
  ): Promise<MemoryManagementDecision[]> {
    await this.preload(records.map((record) => record.partition));
    const decisions: MemoryManagementDecision[] = [];
    for (const record of records) decisions.push(await this.authorizeRecord(record, mode));
    return decisions;
  }

  /** Load environment rows and repository grant owners for these partitions in bulk. */
  private async preload(partitions: readonly MemoryPartition[]): Promise<void> {
    const authorization = this.deps.authorization;
    await Promise.all([
      this.deps.environments.preload(
        partitions.flatMap((partition) =>
          partition.type === "environment" ? [partition.environmentId] : []
        )
      ),
      authorization && this.can("repositories.read")
        ? this.deps.repositoryGrants.preload(
            authorization,
            partitions.filter((partition) => partition.type === "repository")
          )
        : undefined,
    ]);
  }

  /** Read access to the partition, plus management authority for writes. */
  private async authorizePartition(
    partition: MemoryPartition,
    scope: MemoryScope,
    mode: "read" | "write"
  ): Promise<MemoryManagementDecision> {
    const access = await this.partitionAccess(partition, scope);
    if (access.kind === "denied") return access;
    if (mode === "read" || access.canManage) return granted(partition, scope, access.canManage);
    return denied({
      reason: "forbidden",
      message: `${SCOPE_LABELS[partition.type]} memory management permission required`,
    });
  }

  /**
   * Resolve a named scope to its stable partition (repositories by their installed ID), with
   * the display scope to store or show (resolved repository names).
   */
  private async resolvePartition(
    scope: MemoryScope
  ): Promise<
    { kind: "resolved"; partition: MemoryPartition; scope: MemoryScope } | DeniedDecision
  > {
    switch (scope.type) {
      case "personal":
        return {
          kind: "resolved",
          partition: { type: "personal", userId: this.deps.userId },
          scope,
        };
      case "environment":
        return {
          kind: "resolved",
          partition: { type: "environment", environmentId: scope.environmentId },
          scope,
        };
      case "repository": {
        // Checked before the source-control lookup, which only permitted callers should cause.
        if (!this.can("repositories.read")) return REPOSITORY_READ_REQUIRED;
        const repo = await this.deps.repositories.resolve(scope.repoOwner, scope.repoName);
        const partition = repositoryPartition(repo);
        return partition
          ? {
              kind: "resolved",
              partition,
              scope: { type: "repository", repoOwner: repo.repoOwner, repoName: repo.repoName },
            }
          : NOT_FOUND;
      }
      default:
        return unhandled("memory scope", scope);
    }
  }

  /** The principal's read/manage access to a partition; `scope` only labels denials. */
  private partitionAccess(
    partition: MemoryPartition,
    scope?: MemoryScope
  ): Promise<PartitionAccess> {
    switch (partition.type) {
      case "personal":
        return this.personalAccess(partition);
      case "environment":
        return this.environmentAccess(partition);
      case "repository":
        return this.repositoryAccess(partition, scope);
      default:
        return unhandled("memory partition", partition);
    }
  }

  /** Personal stores are owner-only, even for administrators and collaborators. */
  private async personalAccess(
    partition: Extract<MemoryPartition, { type: "personal" }>
  ): Promise<PartitionAccess> {
    if (partition.userId !== this.deps.userId) return NOT_FOUND;
    if (!this.can("memories.manage_own"))
      return denied({ reason: "forbidden", message: "Personal memory permission required" });
    return { kind: "granted", canManage: true };
  }

  private async environmentAccess(
    partition: Extract<MemoryPartition, { type: "environment" }>
  ): Promise<PartitionAccess> {
    const read = await this.deps.environments.evaluate(partition.environmentId, "read");
    if (read.kind !== "allowed") return admissionDenial(read);
    const manage = await this.deps.environments.evaluate(partition.environmentId, "manage");
    return {
      kind: "granted",
      canManage: manage.kind === "allowed" && this.can("environments.settings.manage"),
    };
  }

  /** Repository grants are evaluated by the stable repository ID. */
  private async repositoryAccess(
    partition: RepositoryPartition,
    scope?: MemoryScope
  ): Promise<PartitionAccess> {
    const authorization = this.deps.authorization;
    if (!authorization || !this.can("repositories.read")) return REPOSITORY_READ_REQUIRED;
    const target = [partition];
    if (await this.deps.repositoryGrants.ungrantedRepository(authorization, target))
      return grantDenial(
        scope?.type === "repository"
          ? `${scope.repoOwner}/${scope.repoName}`
          : `repository ${partition.repoId}`
      );
    const canManage =
      this.can("repositories.settings.manage") &&
      !(await this.deps.repositoryGrants.ungrantedRepository(authorization, target, {
        requireLead: true,
      }));
    return { kind: "granted", canManage };
  }

  private can(permission: PermissionId): boolean {
    return this.deps.authorization?.permissions.includes(permission) ?? false;
  }
}

// ---------------------------------------------------------------------------
// Session principals
// ---------------------------------------------------------------------------

export type SessionMemoryAccessDecision =
  | { kind: "granted" }
  | {
      kind: "denied";
      reason:
        | "team_inactive"
        | "repository_ungranted"
        | "owner_unavailable"
        | "environment_unavailable"
        | "personal_unavailable";
      /** The partition that failed, when a single one can be identified. */
      partition?: MemoryPartition;
    };

/** Dependencies injected into SessionMemoryAccessPolicy. */
export interface SessionMemoryAccessPolicyDeps {
  teams: Pick<TeamStore, "isActive">;
  grants: Pick<TeamRepositoryGrantStore, "covers">;
  environments: Pick<EnvironmentStore, "getById">;
  authorization: Pick<AuthorizationService, "getEffectiveAuthorization">;
  repositoryGrants: RepositoryGrants;
}

const SESSION_ACCESS_GRANTED: SessionMemoryAccessDecision = { kind: "granted" };

/** A user's current authorization, or null when they have none. */
type AuthorizationLoader = (userId: string) => Promise<EffectiveAuthorization | null>;

/** The same permission that gates the owner's personal catalog in Settings. */
function mayUsePersonalMemory(authorization: EffectiveAuthorization | null): boolean {
  return (
    authorization !== null &&
    authorization.suspendedAt === null &&
    authorization.permissions.includes("memories.manage_own")
  );
}

/**
 * Whether a session's principal may read memory partitions right now. A pinned manifest or an
 * issued sandbox token never freezes access: team activity, repository grants, owner suspension,
 * environment ownership, and the personal owner's `memories.manage_own` are evaluated on every
 * check. Which personal store a session reaches is governed by its pinned owner, their opt-out and
 * the prompt being processed (`memory/session-rules.ts`); this only decides whether that owner may
 * still use it, so agents never write memories the owner
 * cannot review in Settings. Like any partition, a denied personal store fails the whole check;
 * callers that can do without it (selection, boot context, unscoped search) leave it out first.
 *
 * Each check loads a user's authorization at most once, but never reuses it across checks: callers
 * recheck around reads (search does so before and after its query), and every recheck must
 * observe revocations made in between.
 */
export class SessionMemoryAccessPolicy {
  constructor(private readonly deps: SessionMemoryAccessPolicyDeps) {}

  async check(
    principal: SessionPrincipal,
    partitions: readonly MemoryPartition[]
  ): Promise<SessionMemoryAccessDecision> {
    const authorizationFor = this.authorizationLoader();
    const repositories = partitions.filter((partition) => partition.type === "repository");
    const repositoryDecision = principal.ownerTeamId
      ? await this.teamRepositoryAccess(principal.ownerTeamId, repositories)
      : await this.ownerRepositoryAccess(principal.userId, repositories, authorizationFor);
    if (repositoryDecision.kind === "denied") return repositoryDecision;
    for (const partition of partitions) {
      if (partition.type === "personal") {
        if (!mayUsePersonalMemory(await authorizationFor(partition.userId)))
          return { kind: "denied", reason: "personal_unavailable", partition };
        continue;
      }
      if (partition.type !== "environment") continue;
      const environment = await this.deps.environments.getById(partition.environmentId);
      if (
        !environment ||
        (environment.owner_team_id && environment.owner_team_id !== principal.ownerTeamId)
      )
        return { kind: "denied", reason: "environment_unavailable", partition };
    }
    return SESSION_ACCESS_GRANTED;
  }

  /** Team sessions read what an active team's grants cover. */
  private async teamRepositoryAccess(
    teamId: string,
    repositories: readonly RepositoryPartition[]
  ): Promise<SessionMemoryAccessDecision> {
    if (!(await this.deps.teams.isActive(teamId)))
      return { kind: "denied", reason: "team_inactive" };
    const covered = await this.deps.grants.covers(
      teamId,
      repositories.map((repo) => repo.repoId)
    );
    return covered ? SESSION_ACCESS_GRANTED : { kind: "denied", reason: "repository_ungranted" };
  }

  /** Workspace sessions read what their active owner's workspace grants allow. */
  private async ownerRepositoryAccess(
    userId: string | null,
    repositories: readonly RepositoryPartition[],
    authorizationFor: AuthorizationLoader
  ): Promise<SessionMemoryAccessDecision> {
    const authorization = userId ? await authorizationFor(userId) : null;
    if (!authorization || authorization.suspendedAt !== null)
      return { kind: "denied", reason: "owner_unavailable" };
    const ungranted = await this.deps.repositoryGrants.ungrantedRepository(
      authorization,
      repositories
    );
    return ungranted
      ? { kind: "denied", reason: "repository_ungranted", partition: ungranted }
      : SESSION_ACCESS_GRANTED;
  }

  /** Load each user's authorization at most once within one check. */
  private authorizationLoader(): AuthorizationLoader {
    const loaded = new Map<string, Promise<EffectiveAuthorization | null>>();
    return (userId) => {
      let authorization = loaded.get(userId);
      if (!authorization) {
        authorization = this.deps.authorization.getEffectiveAuthorization(userId).catch((cause) => {
          if (cause instanceof AuthorizationError) return null;
          throw cause;
        });
        loaded.set(userId, authorization);
      }
      return authorization;
    };
  }
}
