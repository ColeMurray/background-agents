import { partitionPredicate, type MemoryPartition } from "../memory/partition";
import { sql, type SqlFragment } from "./sql-fragment";

/**
 * A memory as of its current revision. Queries alias the record `m` and the revision `r`;
 * select columns from either (e.g. `SELECT m.*, r.title ${CURRENT_MEMORY}`).
 */
export const CURRENT_MEMORY = sql`FROM memories m
  JOIN memory_revisions r ON r.id = m.current_revision_id AND r.memory_id = m.id`;

/** Rows belonging to any of `partitions`; callers must pass at least one. */
export function inPartitions(partitions: readonly MemoryPartition[]): SqlFragment {
  return sql`(${sql.join(
    partitions.map((partition) => sql`(${partitionPredicate(partition)})`),
    " OR "
  )})`;
}
