"use client";

import { useCallback } from "react";
import useSWRInfinite from "swr/infinite";
import { useAuthSession } from "@/lib/auth-session";
import {
  SESSIONS_PAGE_SIZE,
  toSessionListQuery,
  type SessionDiscoveryQuery,
} from "@/lib/session-discovery";
import {
  buildSessionsPageKey,
  fetchSessionListPage,
  type SessionListItem,
  type SessionListResponse,
} from "@/lib/session-list";

export interface SessionDiscoveryResult {
  sessions: SessionListItem[];
  /** True until the first page of the current query has resolved. */
  loading: boolean;
  loadingMore: boolean;
  error: Error | undefined;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  retry: () => Promise<unknown>;
}

/**
 * Pages GET /sessions for the discovery view. Every page key embeds the full
 * query, so a filter change starts a fresh page chain (and resets to the
 * first page) instead of appending to another filter's pages. With
 * `enabled` false nothing is requested and the result reads as empty.
 */
export function useSessionDiscovery(
  query: SessionDiscoveryQuery,
  { enabled = true }: { enabled?: boolean } = {}
): SessionDiscoveryResult {
  const { data: session, status: authStatus } = useAuthSession();
  const pageKey = useCallback(
    (pageIndex: number, previousPage: SessionListResponse | null) => {
      if (!session || !enabled) return null;
      if (previousPage && !previousPage.hasMore) return null;
      return buildSessionsPageKey(
        toSessionListQuery(query, {
          limit: SESSIONS_PAGE_SIZE,
          offset: pageIndex * SESSIONS_PAGE_SIZE,
        })
      );
    },
    [enabled, query, session]
  );

  // The first page revalidates on remount and focus (the SWR default), so a
  // session renamed, archived, or started elsewhere shows up on return.
  const { data, error, isValidating, mutate, setSize, size } = useSWRInfinite<SessionListResponse>(
    pageKey,
    fetchSessionListPage,
    { shouldRetryOnError: false }
  );

  const loadedPages = data?.filter((page) => page !== undefined) ?? [];
  // Offset paging over a list ordered by updated_at can hand the same row to
  // two pages when a session between them is bumped to the top. Keep the
  // first occurrence so a row never renders twice.
  const seen = new Set<string>();
  const sessions = loadedPages
    .flatMap((page) => page.sessions)
    .filter((entry) => (seen.has(entry.id) ? false : (seen.add(entry.id), true)));
  const lastPage = loadedPages.at(-1);
  const loading = authStatus === "loading" || (enabled && !!session && !data && !error);
  const loadingMore = !!data && isValidating && data[size - 1] === undefined;
  const hasMore = lastPage?.hasMore ?? false;

  return {
    sessions,
    loading,
    loadingMore,
    error: error instanceof Error ? error : undefined,
    hasMore,
    loadMore: async () => {
      if (loadingMore || !hasMore) return;
      await setSize((pageCount) => pageCount + 1);
    },
    retry: () => mutate(),
  };
}
