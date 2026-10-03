import type { MemoryScope, MemoryScopeType } from "@open-inspect/shared/types/memories";
import { sql, type SqlFragment } from "../db/sql-fragment";

/**
 * The stable identity a memory belongs to. Requests name scopes (`MemoryScope`); the control
 * plane resolves each to a partition once, at the edge, and stores/authorizes by partition only.
 * Repository partitions are keyed by the stable repository ID — names are display-only, so a
 * renamed or transferred repository keeps its memories.
 */
export type MemoryPartition =
  | { type: "personal"; userId: string }
  | { type: "repository"; repoId: number; repoOwner: string; repoName: string }
  | { type: "environment"; environmentId: string };

/** The storage columns that encode a partition. */
export interface PartitionColumns {
  scope_type: MemoryScopeType;
  scope_key: string;
  repo_owner: string | null;
  repo_name: string | null;
}

function unreachable(value: never): never {
  throw new Error(`Unhandled memory partition: ${JSON.stringify(value)}`);
}

export function partitionKey(partition: MemoryPartition): string {
  switch (partition.type) {
    case "personal":
      return partition.userId;
    case "repository":
      return String(partition.repoId);
    case "environment":
      return partition.environmentId;
    default:
      return unreachable(partition);
  }
}

export function partitionColumns(partition: MemoryPartition): PartitionColumns {
  return {
    scope_type: partition.type,
    scope_key: partitionKey(partition),
    repo_owner: partition.type === "repository" ? partition.repoOwner : null,
    repo_name: partition.type === "repository" ? partition.repoName : null,
  };
}

export function partitionFromColumns(row: PartitionColumns): MemoryPartition {
  switch (row.scope_type) {
    case "personal":
      return { type: "personal", userId: row.scope_key };
    case "repository":
      return {
        type: "repository",
        repoId: Number(row.scope_key),
        repoOwner: row.repo_owner!,
        repoName: row.repo_name!,
      };
    case "environment":
      return { type: "environment", environmentId: row.scope_key };
    default:
      return unreachable(row.scope_type);
  }
}

/** The request/display shape of a partition (personal owner identity is not exposed). */
export function partitionScope(partition: MemoryPartition): MemoryScope {
  switch (partition.type) {
    case "personal":
      return { type: "personal" };
    case "repository":
      return { type: "repository", repoOwner: partition.repoOwner, repoName: partition.repoName };
    case "environment":
      return { type: "environment", environmentId: partition.environmentId };
    default:
      return unreachable(partition);
  }
}

export function samePartition(a: MemoryPartition, b: MemoryPartition): boolean {
  return a.type === b.type && partitionKey(a) === partitionKey(b);
}

/** Match rows of one partition; queries alias the memories table as `m`. */
export function partitionPredicate(partition: MemoryPartition): SqlFragment {
  return sql`m.scope_type = ${partition.type} AND m.scope_key = ${partitionKey(partition)}`;
}
