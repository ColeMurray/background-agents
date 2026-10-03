import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { useAuthSession } from "@/lib/auth-session";
import { SwrFetchError } from "@/lib/swr-fetch-error";
import {
  DEFAULT_AUTOMATION_LIST_PAGE_SIZE,
  listAutomationsResponseSchema,
} from "@open-inspect/shared";
import type {
  AutomationView,
  ListAutomationsResponse,
  ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";

/**
 * Deleted or inaccessible resources must not render from cache; only transient failures
 * (network, 5xx) keep the last loaded data.
 */
function isTerminalAutomationError(error: unknown): boolean {
  return error instanceof SwrFetchError && [401, 403, 404].includes(error.status);
}

function buildAutomationListPath(
  nameSearch: string,
  teamId?: string | null,
  cursor?: string
): `/api/${string}` {
  const searchParams = new URLSearchParams({ limit: String(DEFAULT_AUTOMATION_LIST_PAGE_SIZE) });
  if (nameSearch) searchParams.set("search", nameSearch);
  if (teamId) searchParams.set("teamId", teamId);
  if (cursor) searchParams.set("cursor", cursor);
  return `/api/automations?${searchParams.toString()}`;
}

export function useAutomations(nameSearch: string, teamId?: string | null) {
  const { data: session, status: authStatus } = useAuthSession();
  const { fetcher } = useSWRConfig();
  const normalizedNameSearch = nameSearch.trim();

  const fetchAutomationPage = async (path: string): Promise<ListAutomationsResponse> => {
    if (!fetcher) throw new Error("Missing SWR fetcher");
    const parsed = listAutomationsResponseSchema.safeParse(await fetcher(path));
    if (!parsed.success) throw new Error("Invalid automations response");
    return parsed.data;
  };

  const { data, error, isValidating, mutate, setSize, size } =
    useSWRInfinite<ListAutomationsResponse>(
      (pageIndex, previousPage) => {
        if (!session) return null;
        if (pageIndex === 0) return buildAutomationListPath(normalizedNameSearch, teamId);
        if (!previousPage?.hasMore) return null;
        return buildAutomationListPath(normalizedNameSearch, teamId, previousPage.nextCursor);
      },
      fetchAutomationPage,
      { revalidateFirstPage: true }
    );

  // Invalidation evicts cached pages so inactive lists never remount with stale records. A
  // mounted list keeps showing its last pages for the same query while they refetch, and
  // through a transient refetch failure.
  const listKey = session ? buildAutomationListPath(normalizedNameSearch, teamId) : null;
  const [retained, setRetained] = useState<{
    key: string;
    pages: ListAutomationsResponse[];
  } | null>(null);
  if (data && listKey && (retained?.key !== listKey || retained.pages !== data)) {
    setRetained({ key: listKey, pages: data });
  }
  const pages = isTerminalAutomationError(error)
    ? undefined
    : (data ?? (retained && retained.key === listKey ? retained.pages : undefined));

  const loadedPages = pages?.filter((page) => page !== undefined) ?? [];
  const automations = loadedPages.flatMap((page) => page.automations);
  const lastPage = loadedPages[loadedPages.length - 1];
  const loading = authStatus === "loading" || (!!session && !pages && !error);
  const loadingMore = !!data && isValidating && data[size - 1] === undefined;
  const hasMore = lastPage?.hasMore ?? false;

  return {
    automations,
    loading,
    loadingMore,
    error: error instanceof Error ? error : undefined,
    hasMore,
    loadMore: async () => {
      if (loadingMore || !hasMore) return;
      await setSize((pageCount) => pageCount + 1);
    },
    mutate,
  };
}

export function useAutomation(id: string | undefined) {
  const { data: session } = useAuthSession();

  const { data, error, isLoading, mutate } = useSWR<{ automation: AutomationView }>(
    session && id ? `/api/automations/${id}` : null
  );

  return {
    automation: isTerminalAutomationError(error) ? null : (data?.automation ?? null),
    loading: isLoading,
    mutate,
  };
}

export function useAutomationInvocations(id: string | undefined, limit = 20, offset = 0) {
  const { data: session } = useAuthSession();

  const { data, error, isLoading, mutate } = useSWR<ListAutomationInvocationsResponse>(
    session && id ? `/api/automations/${id}/invocations?limit=${limit}&offset=${offset}` : null
  );
  const visible = isTerminalAutomationError(error) ? undefined : data;

  return {
    invocations: visible?.invocations ?? [],
    total: visible?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}
