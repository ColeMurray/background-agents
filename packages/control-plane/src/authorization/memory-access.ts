import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { MemoryScope, MemoryScopeType } from "@open-inspect/shared/types/memories";
import type { AuthorizationService } from "./service";
import type { EnvironmentStore } from "../db/environments";
import type { TeamRepositoryGrantStore } from "../db/team-repository-grants";
import type { TeamStore } from "../db/teams";
import type { MemoryPartition } from "../memory/partition";
import { repositoryPartition } from "../memory/sources";
import type { MemoryRecord, SessionPrincipal } from "../memory/types";
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
 * - can a session's principal read shared partitions right now ({@link SessionMemoryAccessPolicy}),
 *   asked when a session's memory is selected and again on every sandbox read, search, write,
 *   and boot;
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
type DeniedDecision = Extract<MemoryManagementDecision, { kind: "denied" }>;
const NOT_FOUND: DeniedDecision = {
  kind: "denied",
  denial: { reason: "not_found", message: "Memory not found" },
};
const REPOSITORY_READ_REQUIRED: DeniedDecision = {
  kind: "denied",
  denial: { reason: "forbidden", message: "Repository read permission required" },
};

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

  /** Authorize a request about a scope a person named: listing, creating, or previewing. */
  async authorizeScope(
    scope: MemoryScope,
    mode: "read" | "write"
  ): Promise<MemoryManagementDecision> {
    const resolved = await this.resolvePartition(scope);
    return resolved.kind === "denied"
      ? resolved
      : this.authorizePartition(resolved.partition, mode);
  }

  /**
   * Authorize a request about an existing record by its stored partition identity, never its
   * display names: a renamed repository's memories stay manageable, and a repository that reuses
   * a name gains nothing. Another owner's personal record is indistinguishable from none.
   */
  authorizeRecord(record: MemoryRecord, mode: "read" | "write"): Promise<MemoryManagementDecision> {
    return this.authorizePartition(record.partition, mode);
  }

  /** Read access to the partition, plus management authority for writes. */
  private async authorizePartition(
    partition: MemoryPartition,
    mode: "read" | "write"
  ): Promise<MemoryManagementDecision> {
    const decision = await this.partitionAccess(partition);
    if (decision.kind === "denied" || mode === "read" || decision.canManage) return decision;
    return denied({
      reason: "forbidden",
      message: `${SCOPE_LABELS[partition.type]} memory management permission required`,
    });
  }

  /** Resolve a named scope to its stable partition (repositories by their installed ID). */
  private async resolvePartition(
    scope: MemoryScope
  ): Promise<{ kind: "resolved"; partition: MemoryPartition } | DeniedDecision> {
    switch (scope.type) {
      case "personal":
        return { kind: "resolved", partition: { type: "personal", userId: this.deps.userId } };
      case "environment":
        return {
          kind: "resolved",
          partition: { type: "environment", environmentId: scope.environmentId },
        };
      case "repository": {
        // Checked before the source-control lookup, which only permitted callers should cause.
        if (!this.can("repositories.read")) return REPOSITORY_READ_REQUIRED;
        const partition = repositoryPartition(
          await this.deps.repositories.resolve(scope.repoOwner, scope.repoName)
        );
        return partition ? { kind: "resolved", partition } : NOT_FOUND;
      }
      default: {
        const exhaustive: never = scope;
        throw new Error(`Unhandled memory scope: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** The principal's read/manage access to a partition. */
  private partitionAccess(partition: MemoryPartition): Promise<MemoryManagementDecision> {
    switch (partition.type) {
      case "personal":
        return this.personalAccess(partition);
      case "environment":
        return this.environmentAccess(partition);
      case "repository":
        return this.repositoryAccess(partition);
      default: {
        const exhaustive: never = partition;
        throw new Error(`Unhandled memory partition: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /** Personal stores are owner-only, even for administrators and collaborators. */
  private async personalAccess(
    partition: Extract<MemoryPartition, { type: "personal" }>
  ): Promise<MemoryManagementDecision> {
    if (partition.userId !== this.deps.userId) return NOT_FOUND;
    if (!this.can("memories.manage_own"))
      return denied({ reason: "forbidden", message: "Personal memory permission required" });
    return granted(partition, true);
  }

  private async environmentAccess(
    partition: Extract<MemoryPartition, { type: "environment" }>
  ): Promise<MemoryManagementDecision> {
    const read = await this.deps.environments.evaluate(partition.environmentId, "read");
    if (read.kind !== "allowed") return admissionDenial(read);
    const manage = await this.deps.environments.evaluate(partition.environmentId, "manage");
    return granted(
      partition,
      manage.kind === "allowed" && this.can("environments.settings.manage")
    );
  }

  /** Repository grants are evaluated by the stable repository ID. */
  private async repositoryAccess(
    partition: Extract<MemoryPartition, { type: "repository" }>
  ): Promise<MemoryManagementDecision> {
    const authorization = this.deps.authorization;
    if (!authorization || !this.can("repositories.read")) return REPOSITORY_READ_REQUIRED;
    const target = [
      { owner: partition.repoOwner, name: partition.repoName, repoId: partition.repoId },
    ];
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

export type SessionMemoryAccessDecision =
  | { kind: "granted" }
  | {
      kind: "denied";
      reason:
        | "team_inactive"
        | "repository_ungranted"
        | "owner_unavailable"
        | "environment_unavailable";
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

/**
 * Whether a session's principal may read shared memory partitions right now. A pinned manifest
 * or an issued sandbox token never freezes access: team activity, repository grants, owner
 * suspension, and environment ownership are evaluated on every check. Personal partitions are
 * governed by the session's pinned owner and opt-out instead, and always pass here.
 *
 * Instances are request-scoped; a workspace owner's authorization is loaded once per instance.
 */
export class SessionMemoryAccessPolicy {
  private readonly ownerAuthorizations = new Map<string, Promise<EffectiveAuthorization | null>>();

  constructor(private readonly deps: SessionMemoryAccessPolicyDeps) {}

  async check(
    principal: SessionPrincipal,
    partitions: readonly MemoryPartition[]
  ): Promise<SessionMemoryAccessDecision> {
    const repositories = partitions.filter((partition) => partition.type === "repository");
    const repositoryDecision = principal.ownerTeamId
      ? await this.teamRepositoryAccess(principal.ownerTeamId, repositories)
      : await this.ownerRepositoryAccess(principal.userId, repositories);
    if (repositoryDecision.kind === "denied") return repositoryDecision;
    for (const partition of partitions) {
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
    repositories: readonly Extract<MemoryPartition, { type: "repository" }>[]
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
    repositories: readonly Extract<MemoryPartition, { type: "repository" }>[]
  ): Promise<SessionMemoryAccessDecision> {
    const authorization = userId ? await this.ownerAuthorization(userId) : null;
    if (!authorization || authorization.suspendedAt !== null)
      return { kind: "denied", reason: "owner_unavailable" };
    const ungranted = await this.deps.repositoryGrants.ungrantedRepository(
      authorization,
      repositories.map((repo) => ({
        owner: repo.repoOwner,
        name: repo.repoName,
        repoId: repo.repoId,
      }))
    );
    return ungranted
      ? {
          kind: "denied",
          reason: "repository_ungranted",
          partition: repositories.find((repo) => repo.repoId === ungranted.repoId),
        }
      : SESSION_ACCESS_GRANTED;
  }

  private ownerAuthorization(userId: string): Promise<EffectiveAuthorization | null> {
    let loaded = this.ownerAuthorizations.get(userId);
    if (!loaded) {
      loaded = this.deps.authorization.getEffectiveAuthorization(userId).catch((cause) => {
        if (cause instanceof AuthorizationError) return null;
        throw cause;
      });
      this.ownerAuthorizations.set(userId, loaded);
    }
    return loaded;
  }
}
