import useSWR, { useSWRConfig } from "swr";
import useSWRInfinite from "swr/infinite";
import { useAuthSession } from "@/lib/auth-session";
import { listAutomationsResponseSchema } from "@open-inspect/shared";
import type {
  Automation,
  ListAutomationsResponse,
  ListAutomationInvocationsResponse,
} from "@open-inspect/shared/types/automations";

const AUTOMATION_LIST_PAGE_SIZE = 25;

function buildAutomationListPath(nameSearch: string, cursor?: string): `/api/${string}` {
  const searchParams = new URLSearchParams({ limit: String(AUTOMATION_LIST_PAGE_SIZE) });
  if (nameSearch) searchParams.set("search", nameSearch);
  if (cursor) searchParams.set("cursor", cursor);
  return `/api/automations?${searchParams.toString()}`;
}

export function useAutomations(nameSearch: string) {
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
        if (pageIndex === 0) return buildAutomationListPath(normalizedNameSearch);
        if (!previousPage?.hasMore) return null;
        return buildAutomationListPath(normalizedNameSearch, previousPage.nextCursor);
      },
      fetchAutomationPage,
      { revalidateFirstPage: true }
    );

  const loadedPages = data?.filter((page) => page !== undefined) ?? [];
  const automations = loadedPages.flatMap((page) => page.automations);
  const lastPage = loadedPages[loadedPages.length - 1];
  const loading = authStatus === "loading" || (!!session && !data && !error);
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

  const { data, isLoading, mutate } = useSWR<{ automation: Automation }>(
    session && id ? `/api/automations/${id}` : null
  );

  return {
    automation: data?.automation ?? null,
    loading: isLoading,
    mutate,
  };
}

export function useAutomationInvocations(id: string | undefined, limit = 20, offset = 0) {
  const { data: session } = useAuthSession();

  const { data, isLoading, mutate } = useSWR<ListAutomationInvocationsResponse>(
    session && id ? `/api/automations/${id}/invocations?limit=${limit}&offset=${offset}` : null
  );

  return {
    invocations: data?.invocations ?? [],
    total: data?.total ?? 0,
    loading: isLoading,
    mutate,
  };
}
