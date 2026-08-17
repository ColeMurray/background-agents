"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { useAuthSession } from "@/lib/auth-session";
import useSWR, { mutate, useSWRConfig } from "swr";
import type {
  SessionInboxCategory,
  SessionInboxItem,
  SessionInboxPage,
  SessionInboxSnapshot,
  SessionListItem,
} from "@open-inspect/shared/types/session-inbox";
import {
  buildSessionInboxKey,
  buildSessionInboxSnapshotKey,
  isSessionInboxKey,
} from "@/lib/session-inbox-api";
import {
  markLatestMessageRead,
  reconcileSessionReadState,
  readStateFromResult,
} from "@/lib/session-read-state";

const VISIBLE_INBOX_POLL_MS = 30_000;
export const SESSION_CREATOR_FILTER_STORAGE_KEY = "open-inspect-sidebar-session-creator-filter";

export type SessionItem = SessionListItem;
type SessionCreatorFilter = "all" | "mine";
type PaginationKey = ReturnType<typeof buildSessionInboxKey>;

interface AdditionalPagesState {
  filterIdentity: string;
  pages: Array<{ page: SessionInboxPage; sequence: number }>;
}

interface PaginationRequest {
  filterIdentity: string;
  key: PaginationKey;
}

function useCategoryPagination(
  category: SessionInboxCategory,
  snapshot: SessionInboxSnapshot | undefined,
  filterIdentity: string,
  canonicalRootIds: Set<string>,
  mine: boolean,
  refreshSnapshot: () => Promise<unknown>,
  nextPageSequence: MutableRefObject<number>
) {
  const { fetcher } = useSWRConfig();
  const [additionalPagesState, setAdditionalPagesState] = useState<AdditionalPagesState>({
    filterIdentity,
    pages: [],
  });
  const [paginationRequest, setPaginationRequest] = useState<PaginationRequest | null>(null);
  const firstPage = snapshot?.categories[category];
  const additionalPages =
    additionalPagesState.filterIdentity === filterIdentity ? additionalPagesState.pages : [];

  useEffect(() => {
    setAdditionalPagesState({ filterIdentity, pages: [] });
    setPaginationRequest(null);
  }, [filterIdentity]);

  useEffect(() => {
    setAdditionalPagesState((state) => {
      if (state.filterIdentity !== filterIdentity) return state;
      const pages = state.pages.map(({ page, sequence }) => ({
        sequence,
        page: {
          ...page,
          items: page.items.filter((item) => !canonicalRootIds.has(item.rootSession.id)),
        },
      }));
      return { filterIdentity, pages };
    });
  }, [canonicalRootIds, filterIdentity]);

  const {
    data: loadedPage,
    error,
    isLoading: loadingMore,
    mutate: retryPage,
  } = useSWR<SessionInboxPage>(
    paginationRequest ? [paginationRequest.key, paginationRequest.filterIdentity] : null,
    paginationRequest
      ? () => {
          if (!fetcher) throw new Error("Missing SWR fetcher");
          return fetcher(paginationRequest.key) as Promise<SessionInboxPage>;
        }
      : null,
    { shouldRetryOnError: false }
  );

  useEffect(() => {
    if (!loadedPage || !paginationRequest) return;
    if (paginationRequest.filterIdentity === filterIdentity) {
      const sequence = nextPageSequence.current++;
      const page = {
        ...loadedPage,
        items: loadedPage.items.filter((item) => !canonicalRootIds.has(item.rootSession.id)),
      };
      setAdditionalPagesState((state) => ({
        filterIdentity,
        pages: [
          ...(state.filterIdentity === filterIdentity ? state.pages : []),
          { page, sequence },
        ],
      }));
    }
    setPaginationRequest(null);
  }, [canonicalRootIds, filterIdentity, loadedPage, nextPageSequence, paginationRequest]);

  const lastPage = additionalPages.at(-1)?.page ?? firstPage;
  const hasMore = lastPage?.hasMore ?? false;
  const loadMore = useCallback(() => {
    if (!snapshot || !lastPage?.nextCursor || paginationRequest) return;
    setPaginationRequest({
      filterIdentity,
      key: buildSessionInboxKey({
        category,
        cursor: lastPage.nextCursor,
        mine,
      }),
    });
  }, [category, filterIdentity, lastPage, mine, paginationRequest, snapshot]);

  const retry = useCallback(
    () => (error && paginationRequest ? retryPage() : refreshSnapshot()),
    [error, paginationRequest, refreshSnapshot, retryPage]
  );

  // Archive and read-state mutations revalidate the head snapshot, but pages
  // loaded through `Load more` live only in this retained state — reconcile
  // them in place or they keep rendering the pre-mutation rows.
  const updateRetainedItems = useCallback(
    (update: (item: SessionInboxItem) => SessionInboxItem | null) => {
      setAdditionalPagesState((state) => ({
        ...state,
        pages: state.pages.map(({ page, sequence }) => ({
          sequence,
          page: {
            ...page,
            items: page.items.flatMap((item) => {
              const updated = update(item);
              return updated ? [updated] : [];
            }),
          },
        })),
      }));
    },
    []
  );

  return {
    firstPageItems: firstPage?.items ?? [],
    additionalPages,
    error,
    isLoading: firstPage === undefined,
    hasMore,
    loadingMore,
    loadMore,
    retry,
    updateRetainedItems,
  };
}

export function useSidebarSessions() {
  const { data: authSession } = useAuthSession();
  const [sessionCreatorFilter, setSessionCreatorFilterState] =
    useState<SessionCreatorFilter | null>(null);

  useEffect(() => {
    let initialFilter: SessionCreatorFilter = "all";
    try {
      const storedFilter = localStorage.getItem(SESSION_CREATOR_FILTER_STORAGE_KEY);
      if (storedFilter === "all" || storedFilter === "mine") initialFilter = storedFilter;
    } catch {
      // Storage is optional; the default remains usable in restricted browsers.
    } finally {
      setSessionCreatorFilterState(initialFilter);
    }
  }, []);

  const setSessionCreatorFilter = useCallback((value: SessionCreatorFilter) => {
    setSessionCreatorFilterState(value);
    try {
      localStorage.setItem(SESSION_CREATOR_FILTER_STORAGE_KEY, value);
    } catch {
      // Continue with the in-memory preference when storage is unavailable.
    }
  }, []);

  const enabled = Boolean(authSession) && sessionCreatorFilter !== null;
  const mine = sessionCreatorFilter === "mine";
  const snapshotKey = enabled ? buildSessionInboxSnapshotKey(mine) : null;
  const {
    data: snapshot,
    error: snapshotError,
    isLoading,
    mutate: refreshSnapshot,
  } = useSWR<SessionInboxSnapshot>(snapshotKey, {
    refreshInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "visible"
        ? VISIBLE_INBOX_POLL_MS
        : 0,
    refreshWhenHidden: false,
  });
  const userId = authSession?.user.id ?? null;
  const paginationFilterIdentity = JSON.stringify([userId, mine]);
  const nextPageSequence = useRef(0);
  const canonicalRootIds = useMemo(
    () =>
      new Set(
        snapshot
          ? Object.values(snapshot.categories).flatMap((page) =>
              page.items.map((item) => item.rootSession.id)
            )
          : []
      ),
    [snapshot]
  );
  const refreshInbox = useCallback(async () => {
    await mutate(isSessionInboxKey);
  }, []);
  const attention = useCategoryPagination(
    "needs_attention",
    snapshot,
    paginationFilterIdentity,
    canonicalRootIds,
    mine,
    refreshSnapshot,
    nextPageSequence
  );
  const inProgress = useCategoryPagination(
    "in_progress",
    snapshot,
    paginationFilterIdentity,
    canonicalRootIds,
    mine,
    refreshSnapshot,
    nextPageSequence
  );
  const finished = useCategoryPagination(
    "finished",
    snapshot,
    paginationFilterIdentity,
    canonicalRootIds,
    mine,
    refreshSnapshot,
    nextPageSequence
  );
  const categoryResults = [attention, inProgress, finished];

  const categoryItems = useMemo(() => {
    const results = [
      {
        firstPageItems: attention.firstPageItems,
        additionalPages: attention.additionalPages,
      },
      {
        firstPageItems: inProgress.firstPageItems,
        additionalPages: inProgress.additionalPages,
      },
      {
        firstPageItems: finished.firstPageItems,
        additionalPages: finished.additionalPages,
      },
    ];
    const latestTailSequence = new Map<string, number>();
    for (const result of results) {
      for (const { page, sequence } of result.additionalPages) {
        for (const item of page.items) {
          const id = item.rootSession.id;
          if (!canonicalRootIds.has(id) && sequence > (latestTailSequence.get(id) ?? -1)) {
            latestTailSequence.set(id, sequence);
          }
        }
      }
    }

    return results.map((result) => {
      const renderedIds = new Set(result.firstPageItems.map((item) => item.rootSession.id));
      return [
        ...result.firstPageItems,
        ...result.additionalPages.flatMap(({ page, sequence }) =>
          page.items.filter((item) => {
            const id = item.rootSession.id;
            if (renderedIds.has(id) || latestTailSequence.get(id) !== sequence) return false;
            renderedIds.add(id);
            return true;
          })
        ),
      ];
    });
  }, [
    attention.additionalPages,
    attention.firstPageItems,
    canonicalRootIds,
    finished.additionalPages,
    finished.firstPageItems,
    inProgress.additionalPages,
    inProgress.firstPageItems,
  ]);
  const [attentionItems, inProgressItems, finishedItems] = categoryItems;

  const inboxItems = useMemo(
    () => [...attentionItems, ...inProgressItems, ...finishedItems],
    [attentionItems, finishedItems, inProgressItems]
  );
  const childrenMap = useMemo(() => {
    const result = new Map<string, SessionItem[]>();
    for (const item of inboxItems) {
      for (const descendant of item.descendantSessions) {
        if (!descendant.parentSessionId) continue;
        const siblings = result.get(descendant.parentSessionId) ?? [];
        siblings.push(descendant);
        result.set(descendant.parentSessionId, siblings);
      }
    }
    for (const siblings of result.values()) {
      siblings.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
    }
    return result;
  }, [inboxItems]);

  const updateAttentionRetained = attention.updateRetainedItems;
  const updateInProgressRetained = inProgress.updateRetainedItems;
  const updateFinishedRetained = finished.updateRetainedItems;
  const updateAllRetainedItems = useCallback(
    (update: (item: SessionInboxItem) => SessionInboxItem | null) => {
      updateAttentionRetained(update);
      updateInProgressRetained(update);
      updateFinishedRetained(update);
    },
    [updateAttentionRetained, updateFinishedRetained, updateInProgressRetained]
  );

  const handleSessionArchived = useCallback(
    async (sessionId: string) => {
      updateAllRetainedItems((item) =>
        item.rootSession.id === sessionId
          ? null
          : {
              ...item,
              descendantSessions: item.descendantSessions.filter(
                (session) => session.id !== sessionId
              ),
            }
      );
      void refreshInbox().catch((error) => {
        console.error("Failed to refresh session inbox after archive", error);
      });
    },
    [refreshInbox, updateAllRetainedItems]
  );

  const handleMarkLatestMessageRead = useCallback(
    async (sessionId: string) => {
      const result = await markLatestMessageRead(sessionId);
      await reconcileSessionReadState(result);
      const readState = readStateFromResult(result);
      const applyReadState = (item: SessionInboxItem): SessionInboxItem => ({
        rootSession:
          item.rootSession.id === sessionId ? { ...item.rootSession, readState } : item.rootSession,
        descendantSessions: item.descendantSessions.map((session) =>
          session.id === sessionId ? { ...session, readState } : session
        ),
      });
      // Attention membership is unread-driven, so a hierarchy whose last unread
      // session was just read no longer belongs in a retained attention page.
      updateAttentionRetained((item) => {
        const updated = applyReadState(item);
        return updated.rootSession.readState.unread ||
          updated.descendantSessions.some((session) => session.readState.unread)
          ? updated
          : null;
      });
      updateInProgressRetained(applyReadState);
      updateFinishedRetained(applyReadState);
      await refreshInbox();
    },
    [refreshInbox, updateAttentionRetained, updateFinishedRetained, updateInProgressRetained]
  );

  return {
    needsAttention: attentionItems.map((item) => item.rootSession),
    running: inProgressItems.map((item) => item.rootSession),
    recent: finishedItems.map((item) => item.rootSession),
    childrenMap,
    loading: sessionCreatorFilter === null || isLoading,
    sessionsError: snapshotError ?? categoryResults.find((result) => result.error)?.error,
    refreshSnapshot,
    sectionPagination: {
      needsAttention: attention,
      running: inProgress,
      recent: finished,
    },
    sessionCreatorFilter,
    setSessionCreatorFilter,
    handleSessionArchived,
    handleMarkLatestMessageRead,
  };
}
