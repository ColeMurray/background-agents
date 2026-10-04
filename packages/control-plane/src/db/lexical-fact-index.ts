import {
  FACT_SEARCH_FIELDS,
  type FactHit,
  type FactQuery,
  type FactSearchField,
  type FactSearchIndex,
  type FactSearchPartition,
} from "../memory/fact-search";
import {
  partitionFromColumns,
  partitionPredicate,
  scopeFromColumns,
  type PartitionColumns,
  type ScopeDisplayColumns,
} from "../memory/partition";
import { likeContains, LIKE_ESCAPE_CLAUSE } from "./like-pattern";
import { CURRENT_MEMORY } from "./memory-queries";
import type { SqlDatabase } from "./sql-database";
import { prepareSql, sql, type SqlFragment } from "./sql-fragment";

interface FactHitRow extends PartitionColumns, ScopeDisplayColumns {
  id: string;
  revision_id: string;
  title: string;
  description: string;
}

const COLUMNS: Record<FactSearchField, SqlFragment> = {
  title: sql`lower(r.title)`,
  description: sql`lower(r.description)`,
  content: sql`lower(r.content)`,
};
const LIKE_ESCAPE = sql.constant(LIKE_ESCAPE_CLAUSE);

const matches = (field: FactSearchField, pattern: string) =>
  sql`${COLUMNS[field]} LIKE ${pattern} ${LIKE_ESCAPE}`;

/** The term matches at least one searchable field. */
const matchesAnyField = (pattern: string) =>
  sql`(${sql.join(
    FACT_SEARCH_FIELDS.map(({ field }) => matches(field, pattern)),
    " OR "
  )})`;

/** The weight of the strongest field the term matches (fields are listed strongest first). */
const strongestFieldWeight = (pattern: string) =>
  sql`(CASE ${sql.join(
    FACT_SEARCH_FIELDS.map(
      ({ field, weight }) => sql`WHEN ${matches(field, pattern)} THEN ${weight}`
    ),
    " "
  )} ELSE 0 END)`;

function searchable({ partition, pinnedIn }: FactSearchPartition): SqlFragment {
  return pinnedIn
    ? sql`(${partitionPredicate(partition)} AND EXISTS (SELECT 1 FROM session_memory_items i
        WHERE i.session_id = ${pinnedIn} AND i.memory_id = m.id))`
    : sql`(${partitionPredicate(partition)})`;
}

/**
 * Portable lexical search: escaped `LIKE` over current active facts, ranked in SQL by
 * {@link FACT_SEARCH_FIELDS} in a single statement. Body matching scans text, so response
 * bounds do not imply constant query cost.
 */
export class LexicalFactIndex implements FactSearchIndex {
  constructor(private readonly db: SqlDatabase) {}

  async search(query: FactQuery): Promise<FactHit[]> {
    if (!query.partitions.length || !query.terms.length) return [];
    const patterns = query.terms.map(likeContains);
    const rows = await prepareSql(
      this.db,
      sql`SELECT m.id, m.partition_type, m.owner_user_id, m.repo_id, m.environment_id,
          m.repo_owner, m.repo_name,
          r.id AS revision_id, r.title, r.description
        ${CURRENT_MEMORY}
        WHERE m.status = 'active' AND m.memory_type = 'fact'
          AND (${sql.join(query.partitions.map(searchable), " OR ")})
          AND ${sql.join(patterns.map(matchesAnyField), " AND ")}
        ORDER BY ${sql.join(patterns.map(strongestFieldWeight), " + ")} DESC, m.updated_at DESC, m.id
        LIMIT ${query.limit + 1}`
    ).all<FactHitRow>();
    return rows.results.map((row) => ({
      id: row.id,
      revisionId: row.revision_id,
      partition: partitionFromColumns(row),
      scope: scopeFromColumns(row),
      title: row.title,
      description: row.description,
    }));
  }
}
