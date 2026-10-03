import {
  MEMORY_SEARCH_LIMITS,
  memorySearchTerms,
  type MemorySearchInput,
  type MemorySearchResponse,
  type MemorySearchResult,
  type MemoryScope,
} from "@open-inspect/shared/types/memories";
import { scopePredicate } from "./memories";
import { likeContains, LIKE_ESCAPE_CLAUSE } from "./like-pattern";
import { assertD1QueryParameterLimit } from "./query-limits";
import type { SqlDatabase } from "./sql-database";

/** Server-derived searchable identity; children restrict personal discovery to inherited pins. */
export interface MemorySearchScope {
  scope: MemoryScope;
  ownerUserId: string | null;
  repoId: number | null;
  personalSessionId?: string;
}
interface SearchRow {
  id: string;
  revision_id: string;
  title: string;
  description: string;
  score: number;
  updated_at: number;
}

/**
 * Search every active current fact in authorized scopes, never the bounded boot catalog.
 * SQL ranks before limiting; per-scope top-(limit+1) candidates suffice for the global top.
 * LIKE body matching scans text: response bounds do not imply constant query cost.
 */
export async function searchMemories(
  db: SqlDatabase,
  input: MemorySearchInput,
  scopes: readonly MemorySearchScope[]
): Promise<MemorySearchResponse> {
  if (!scopes.length) return { results: [], hasMore: false };
  const terms = memorySearchTerms(input.query);
  const match = (field: "title" | "description" | "content") =>
    `lower(r.${field}) LIKE ? ${LIKE_ESCAPE_CLAUSE}`;
  const scoreSql = terms
    .map(
      () =>
        `(CASE WHEN ${match("title")} THEN 5 WHEN ${match("description")} THEN 3 WHEN ${match("content")} THEN 1 ELSE 0 END)`
    )
    .join(" + ");
  const termSql = terms
    .map(() => `(${match("title")} OR ${match("description")} OR ${match("content")})`)
    .join(" AND ");
  const termValues = terms.flatMap((term) => {
    const pattern = likeContains(term);
    return [pattern, pattern, pattern];
  });
  const statements = scopes.map((scope) => {
    const predicate = scopePredicate(scope.scope, scope.ownerUserId, scope.repoId);
    const pins = scope.personalSessionId
      ? "AND EXISTS (SELECT 1 FROM session_memory_items i WHERE i.session_id = ? AND i.memory_id = m.id)"
      : "";
    const values = [
      ...termValues,
      ...predicate.values,
      ...(scope.personalSessionId ? [scope.personalSessionId] : []),
      ...termValues,
      input.limit + 1,
    ];
    assertD1QueryParameterLimit(values.length);
    return db
      .prepare(
        `SELECT m.id, r.id AS revision_id, r.title, r.description, m.updated_at,
      (${scoreSql}) AS score FROM memories m
      JOIN memory_revisions r ON r.id = m.current_revision_id AND r.memory_id = m.id
      WHERE m.status = 'active' AND m.memory_type = 'fact' AND ${predicate.sql}
      ${pins} AND ${termSql} ORDER BY score DESC, m.updated_at DESC, m.id LIMIT ?`
      )
      .bind(...values);
  });
  const batches = await db.batch<SearchRow>(statements);
  const candidates = batches
    .flatMap((batch, index) => batch.results.map((row) => ({ row, scope: scopes[index].scope })))
    .sort(
      (a, b) =>
        b.row.score - a.row.score ||
        b.row.updated_at - a.row.updated_at ||
        (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)
    );
  const results: MemorySearchResult[] = [];
  let hasMore = candidates.length > input.limit;
  for (const { row, scope } of candidates.slice(0, input.limit)) {
    const result = {
      id: row.id,
      revisionId: row.revision_id,
      scope,
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
