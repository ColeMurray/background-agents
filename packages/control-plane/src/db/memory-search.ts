import {
  MEMORY_SEARCH_LIMITS,
  memorySearchTerms,
  type MemorySearchInput,
  type MemorySearchResponse,
  type MemorySearchResult,
} from "@open-inspect/shared/types/memories";
import {
  partitionFromColumns,
  partitionPredicate,
  partitionScope,
  type MemoryPartition,
  type PartitionColumns,
} from "../memory/partition";
import { likeContains, LIKE_ESCAPE_CLAUSE } from "./like-pattern";
import type { SqlDatabase } from "./sql-database";
import { prepareSql, sql, type SqlFragment } from "./sql-fragment";

/** A searchable partition; `pinnedSessionId` restricts it to records pinned in that session. */
export interface SearchPartition {
  partition: MemoryPartition;
  pinnedSessionId?: string;
}
interface SearchRow extends PartitionColumns {
  id: string;
  revision_id: string;
  title: string;
  description: string;
  score: number;
  updated_at: number;
}

const FIELDS = {
  title: sql`lower(r.title)`,
  description: sql`lower(r.description)`,
  content: sql`lower(r.content)`,
};
const LIKE_ESCAPE = sql.from({ sql: LIKE_ESCAPE_CLAUSE, values: [] });

function matches(field: SqlFragment, pattern: string): SqlFragment {
  return sql`${field} LIKE ${pattern} ${LIKE_ESCAPE}`;
}

/** Strongest field match per term: title 5, description 3, body 1. */
function termScore(pattern: string): SqlFragment {
  return sql`(CASE WHEN ${matches(FIELDS.title, pattern)} THEN 5
    WHEN ${matches(FIELDS.description, pattern)} THEN 3
    WHEN ${matches(FIELDS.content, pattern)} THEN 1 ELSE 0 END)`;
}

function termMatch(pattern: string): SqlFragment {
  return sql`(${matches(FIELDS.title, pattern)} OR ${matches(FIELDS.description, pattern)}
    OR ${matches(FIELDS.content, pattern)})`;
}

/** Lexical search over current facts. */
export class MemorySearchStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Search every active current fact in authorized partitions, never just the bounded boot catalog.
   * SQL ranks before limiting; per-partition top-(limit+1) candidates suffice for the global top.
   * LIKE body matching scans text: response bounds do not imply constant query cost.
   */
  async search(
    input: MemorySearchInput,
    partitions: readonly SearchPartition[]
  ): Promise<MemorySearchResponse> {
    if (!partitions.length) return { results: [], hasMore: false };
    const patterns = memorySearchTerms(input.query).map(likeContains);
    const score = sql.join(patterns.map(termScore), " + ");
    const allTerms = sql.join(patterns.map(termMatch), " AND ");
    const statements = partitions.map(({ partition, pinnedSessionId }) =>
      prepareSql(
        this.db,
        sql`SELECT m.id, m.scope_type, m.scope_key, m.repo_owner, m.repo_name, r.id AS revision_id,
            r.title, r.description, m.updated_at, (${score}) AS score
          FROM memories m JOIN memory_revisions r ON r.id = m.current_revision_id AND r.memory_id = m.id
          WHERE m.status = 'active' AND m.memory_type = 'fact' AND ${partitionPredicate(partition)}
            ${
              pinnedSessionId
                ? sql`AND EXISTS (SELECT 1 FROM session_memory_items i
                    WHERE i.session_id = ${pinnedSessionId} AND i.memory_id = m.id)`
                : sql.empty
            }
            AND ${allTerms}
          ORDER BY score DESC, m.updated_at DESC, m.id LIMIT ${input.limit + 1}`
      )
    );
    const candidates = (await this.db.batch<SearchRow>(statements))
      .flatMap((batch) => batch.results)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.updated_at - a.updated_at ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      );
    const results: MemorySearchResult[] = [];
    let hasMore = candidates.length > input.limit;
    for (const row of candidates.slice(0, input.limit)) {
      const result = {
        id: row.id,
        revisionId: row.revision_id,
        scope: partitionScope(partitionFromColumns(row)),
        title: row.title,
        description: row.description,
      };
      if (
        JSON.stringify({ results: [...results, result], hasMore: false }).length >
        MEMORY_SEARCH_LIMITS.response
      ) {
        hasMore = true;
        break;
      }
      results.push(result);
    }
    return { results, hasMore };
  }
}
