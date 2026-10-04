import type { MemoryScope, MemoryScopeType } from "@open-inspect/shared/types/memories";
import { sql, type SqlFragment } from "../db/sql-fragment";
import { unhandled } from "./errors";

/**
 * The stable identity a memory belongs to — identity only. Requests name scopes
 * (`MemoryScope`, with display names); the control plane resolves each to a partition once, at
 * the edge, and stores, matches, and authorizes by partition. Repository partitions are keyed by
 * the stable repository ID, so a renamed or transferred repository keeps its memories and a
 * repository that reuses a name gains nothing. Display names travel separately as a record's
 * `scope`.
 */
export type MemoryPartition =
  | { type: "personal"; userId: string }
  | { type: "repository"; repoId: number }
  | { type: "environment"; environmentId: string };

/** The typed identity columns that encode a partition. */
export interface PartitionColumns {
  partition_type: MemoryScopeType;
  owner_user_id: string | null;
  repo_id: number | null;
  environment_id: string | null;
}

/** Display columns stored alongside a partition (repository names as they were when written). */
export interface ScopeDisplayColumns {
  repo_owner: string | null;
  repo_name: string | null;
}

/**
 * The single indexed key for a partition. Must match the generated `memories.partition_key`
 * column: `COALESCE(owner_user_id, CAST(repo_id AS TEXT), environment_id)`.
 */
export function partitionKey(partition: MemoryPartition): string {
  switch (partition.type) {
    case "personal":
      return partition.userId;
    case "repository":
      return String(partition.repoId);
    case "environment":
      return partition.environmentId;
    default:
      return unhandled("memory partition", partition);
  }
}

export function partitionColumns(partition: MemoryPartition): PartitionColumns {
  return {
    partition_type: partition.type,
    owner_user_id: partition.type === "personal" ? partition.userId : null,
    repo_id: partition.type === "repository" ? partition.repoId : null,
    environment_id: partition.type === "environment" ? partition.environmentId : null,
  };
}

export function partitionFromColumns(row: PartitionColumns): MemoryPartition {
  switch (row.partition_type) {
    case "personal":
      return { type: "personal", userId: row.owner_user_id! };
    case "repository":
      return { type: "repository", repoId: row.repo_id! };
    case "environment":
      return { type: "environment", environmentId: row.environment_id! };
    default:
      return unhandled("memory partition", row.partition_type);
  }
}

export function scopeDisplayColumns(scope: MemoryScope): ScopeDisplayColumns {
  return scope.type === "repository"
    ? { repo_owner: scope.repoOwner, repo_name: scope.repoName }
    : { repo_owner: null, repo_name: null };
}

/** The display scope stored with a record; personal scopes never expose the owner. */
export function scopeFromColumns(row: PartitionColumns & ScopeDisplayColumns): MemoryScope {
  switch (row.partition_type) {
    case "personal":
      return { type: "personal" };
    case "repository":
      return { type: "repository", repoOwner: row.repo_owner!, repoName: row.repo_name! };
    case "environment":
      return { type: "environment", environmentId: row.environment_id! };
    default:
      return unhandled("memory partition", row.partition_type);
  }
}

/** A partition's identity as one comparable string. */
export function partitionId(partition: MemoryPartition): string {
  return `${partition.type}:${partitionKey(partition)}`;
}

export function samePartition(a: MemoryPartition, b: MemoryPartition): boolean {
  return partitionId(a) === partitionId(b);
}

/** Match rows of one partition through the indexed key; queries alias memories as `m`. */
export function partitionPredicate(partition: MemoryPartition): SqlFragment {
  return sql`m.partition_type = ${partition.type} AND m.partition_key = ${partitionKey(partition)}`;
}
