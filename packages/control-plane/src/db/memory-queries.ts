import { FACT_SEARCH_FIELDS, type FactSearchField } from "../memory/fact-search";
import { partitionPredicate, type MemoryPartition } from "../memory/partition";
import { LIKE_ESCAPE_CLAUSE } from "./like-pattern";
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

const SEARCH_COLUMNS: Record<FactSearchField, SqlFragment> = {
  title: sql`lower(r.title)`,
  description: sql`lower(r.description)`,
  content: sql`lower(r.content)`,
};
const LIKE_ESCAPE = sql.constant(LIKE_ESCAPE_CLAUSE);

/** The current revision's `field` matches `pattern`, a lowercase `like-pattern` pattern. */
export const revisionFieldMatches = (field: FactSearchField, pattern: string): SqlFragment =>
  sql`${SEARCH_COLUMNS[field]} LIKE ${pattern} ${LIKE_ESCAPE}`;

/** The pattern matches at least one searchable field of the current revision. */
export const revisionMatchesAnyField = (pattern: string): SqlFragment =>
  sql`(${sql.join(
    FACT_SEARCH_FIELDS.map(({ field }) => revisionFieldMatches(field, pattern)),
    " OR "
  )})`;
