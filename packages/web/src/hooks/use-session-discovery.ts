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
 * first page) instead of appending to another filter's pages.
 */
export function useSessionDiscovery(query: SessionDiscoveryQuery): SessionDiscoveryResult {
  const { data: session, status: authStatus } = useAuthSession();
  const pageKey = useCallback(
    (pageIndex: number, previousPage: SessionListResponse | null) => {
      if (!session) return null;
      if (previousPage && !previousPage.hasMore) return null;
      return buildSessionsPageKey(
        toSessionListQuery(query, {
          limit: SESSIONS_PAGE_SIZE,
          offset: pageIndex * SESSIONS_PAGE_SIZE,
        })
      );
    },
    [query, session]
  );

  const { data, error, isValidating, mutate, setSize, size } = useSWRInfinite<SessionListResponse>(
    pageKey,
    fetchSessionListPage,
    {
      revalidateFirstPage: false,
      shouldRetryOnError: false,
    }
  );

  const loadedPages = data?.filter((page) => page !== undefined) ?? [];
  const sessions = loadedPages.flatMap((page) => page.sessions);
  const lastPage = loadedPages.at(-1);
  const loading = authStatus === "loading" || (!!session && !data && !error);
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
