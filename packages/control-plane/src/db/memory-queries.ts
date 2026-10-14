import { partitionPredicate, type MemoryPartition } from "../memory/partition";
import { MEMORY_SEARCH_FIELDS, type MemorySearchField } from "../memory/search-fields";
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

const SEARCH_COLUMNS: Record<MemorySearchField, SqlFragment> = {
  title: sql`lower(r.title)`,
  description: sql`lower(r.description)`,
  content: sql`lower(r.content)`,
};
const LIKE_ESCAPE = sql.constant(LIKE_ESCAPE_CLAUSE);

/** The current revision's `field` matches `pattern`, a lowercase `like-pattern` pattern. */
export const revisionFieldMatches = (field: MemorySearchField, pattern: string): SqlFragment =>
  sql`${SEARCH_COLUMNS[field]} LIKE ${pattern} ${LIKE_ESCAPE}`;

/** The pattern matches at least one searchable field of the current revision. */
export const revisionMatchesAnyField = (pattern: string): SqlFragment =>
  sql`(${sql.join(
    MEMORY_SEARCH_FIELDS.map((field) => revisionFieldMatches(field, pattern)),
    " OR "
  )})`;

/** Every pattern matches some searchable field; no patterns means no filter. */
export const revisionMatchesAllTerms = (patterns: readonly string[]): SqlFragment =>
  patterns.length ? sql`(${sql.join(patterns.map(revisionMatchesAnyField), " AND ")})` : sql`1 = 1`;
