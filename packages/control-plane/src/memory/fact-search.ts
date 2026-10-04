import {
  MEMORY_SEARCH_LIMITS,
  type MemoryScope,
  type MemorySearchResponse,
  type MemorySearchResult,
} from "@open-inspect/shared/types/memories";
import type { MemoryPartition } from "./partition";

/** A partition to search; `pinnedIn` restricts it to records pinned in that session. */
export interface FactSearchPartition {
  partition: MemoryPartition;
  pinnedIn?: string;
}

/** An engine-independent fact query: every term must match some searchable field. */
export interface FactQuery {
  /** Distinct lowercase literal terms (see `memorySearchTerms`). */
  terms: readonly string[];
  /** Authorized partitions to search; empty means no results. */
  partitions: readonly FactSearchPartition[];
  limit: number;
}

/** One ranked hit: identity and catalog summary only, never the body. */
export interface FactHit {
  id: string;
  revisionId: string;
  partition: MemoryPartition;
  /** Display scope stored with the record. */
  scope: MemoryScope;
  title: string;
  description: string;
}

/**
 * Ranking policy: each term scores its strongest matching field, and a hit's score is the sum
 * over terms. Ties fall back to the most recently updated, then ID. Engine adapters must
 * implement this ordering; listed strongest first.
 */
export const FACT_SEARCH_FIELDS = [
  { field: "title", weight: 5 },
  { field: "description", weight: 3 },
  { field: "content", weight: 1 },
] as const;
export type FactSearchField = (typeof FACT_SEARCH_FIELDS)[number]["field"];

/** Searches current active facts. Implementations decide how; the query decides what. */
export interface FactSearchIndex {
  /** Hits in ranking order, at most `limit + 1` so callers can tell whether more exist. */
  search(query: FactQuery): Promise<FactHit[]>;
}

/**
 * Shape ranked hits into the agent response: at most `limit` results, further bounded by the
 * serialized size the tool contract allows. `hasMore` reports anything left out.
 */
export function factSearchResponse(hits: readonly FactHit[], limit: number): MemorySearchResponse {
  const results: MemorySearchResult[] = [];
  let hasMore = hits.length > limit;
  for (const hit of hits.slice(0, limit)) {
    const result = {
      id: hit.id,
      revisionId: hit.revisionId,
      scope: hit.scope,
      title: hit.title,
      description: hit.description,
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
