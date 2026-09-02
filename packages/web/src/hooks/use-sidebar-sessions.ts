"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MutableRefObject } from "react";
import { useAuthSession } from "@/lib/auth-session";
import useSWR, { mutate, useSWRConfig } from "swr";
import type {
  SessionInboxCategory,
  SessionInboxPage,
  SessionInboxSnapshot,
  SessionListItem,
} from "@open-inspect/shared/types/session-inbox";
import {
  buildSessionInboxKey,
  buildSessionInboxSnapshotKey,
  isSessionInboxItemFullyRead,
  isSessionInboxKey,
} from "@/lib/session-inbox-api";
import {
  applySessionReadOverlay,
  applySessionReadResult,
  getSessionReadOverlay,
  markLatestMessageRead,
  pruneSessionReadOverlay,
  scopeSessionReadOverlay,
  subscribeSessionReadOverlay,
} from "@/lib/session-read-state";

const VISIBLE_INBOX_POLL_MS = 30_000;
const SESSION_CREATOR_FILTER_STORAGE_KEY = "open-inspect-sidebar-session-creator-filter";

export type SessionItem = SessionListItem;
type SessionCreatorFilter = "all" | "mine";

interface LoadedPage {
  page: SessionInboxPage;
  sequence: number;
}

/**
 * Pages loaded through "Load more" have exactly one owner: this state. They
 * are fetched with a plain request and never stored under a cache key, so a
 * remount starts again from the head and nothing can restore a page the
 * server has since changed.
 *
 * A chain of loaded pages continues the head page from its cursor, so it is
 * only coherent with the head it was loaded after. When the head's boundary
 * moves (a row entered or left the first page) the chain is discarded along
 * with any response still in flight; keeping it would hide the rows between
 * the new boundary and the old tail. `generation` counts those resets so a
 * response for an earlier chain can never land in a later one, even one
 * with the same identity.
 */
interface LoadedPagesState {
  identity: string;
  generation: number;
  pages: LoadedPage[];
  loading: boolean;
  error: unknown;
}

function emptyPages(identity: string, generation: number): LoadedPagesState {
  return { identity, generation, pages: [], loading: false, error: undefined };
}

function withoutRoots(page: SessionInboxPage, rootIds: Set<string>): SessionInboxPage {
  return { ...page, items: page.items.filter((item) => !rootIds.has(item.rootSession.id)) };
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
  const firstPage = snapshot?.categories[category];
  const chainIdentity = JSON.stringify([filterIdentity, firstPage?.nextCursor ?? null]);
  const [state, setState] = useState<LoadedPagesState>(() => emptyPages(chainIdentity, 0));
  const current =
    state.identity === chainIdentity ? state : emptyPages(chainIdentity, state.generation);
  const lastPage = current.pages.at(-1)?.page ?? firstPage;

  useEffect(() => {
    setState((previous) =>
      previous.identity === chainIdentity
        ? previous
        : emptyPages(chainIdentity, previous.generation + 1)
    );
  }, [chainIdentity]);

  // Once the head snapshot carries a root, the loaded copy is stale for good:
  // the session may since have been archived or ranked past every loaded page.
  useEffect(() => {
    setState((previous) => {
      let changed = false;
      const pages = previous.pages.map(({ page, sequence }) => {
        const filtered = withoutRoots(page, canonicalRootIds);
        if (filtered.items.length === page.items.length) return { page, sequence };
        changed = true;
        return { page: filtered, sequence };
      });
      return changed ? { ...previous, pages } : previous;
    });
  }, [canonicalRootIds]);

  const requestPage = useCallback(async () => {
    const cursor = lastPage?.nextCursor;
    if (!snapshot || !cursor || current.loading) return;
    const key = buildSessionInboxKey({ category, cursor, mine });
    const generation = current.generation;
    const sequence = nextPageSequence.current++;
    setState((previous) =>
      previous.generation === generation
        ? { ...previous, loading: true, error: undefined }
        : previous
    );
    try {
      if (!fetcher) throw new Error("Missing SWR fetcher");
      const page = withoutRoots((await fetcher(key)) as SessionInboxPage, canonicalRootIds);
      setState((previous) =>
        previous.generation === generation
          ? { ...previous, loading: false, pages: [...previous.pages, { page, sequence }] }
          : previous
      );
    } catch (error) {
      setState((previous) =>
        previous.generation === generation ? { ...previous, loading: false, error } : previous
      );
    }
  }, [
    canonicalRootIds,
    category,
    current.generation,
    current.loading,
    fetcher,
    lastPage,
    mine,
    nextPageSequence,
    snapshot,
  ]);

  const loadMore = useCallback(() => {
    void requestPage();
  }, [requestPage]);
  const retry = useCallback(
    () => (current.error ? requestPage() : refreshSnapshot()),
    [current.error, refreshSnapshot, requestPage]
  );
  const removeSession = useCallback((sessionId: string) => {
    setState((previous) => ({
      ...previous,
      pages: previous.pages.map(({ page, sequence }) => ({
        sequence,
        page: {
          ...page,
          items: page.items.flatMap((item) => {
            if (item.rootSession.id === sessionId) return [];
            return [
              {
                ...item,
                descendantSessions: item.descendantSessions.filter(
                  (session) => session.id !== sessionId
                ),
              },
            ];
          }),
        },
      })),
    }));
  }, []);

  return {
    firstPageItems: firstPage?.items ?? [],
    loadedPages: current.pages,
    error: current.error,
    isLoading: firstPage === undefined,
    hasMore: lastPage?.hasMore ?? false,
    loadingMore: current.loading,
    loadMore,
    retry,
    removeSession,
  };
}

function useSessionReadOverlay() {
  return useSyncExternalStore(
    subscribeSessionReadOverlay,
    getSessionReadOverlay,
    getSessionReadOverlay
  );
}

export function useSidebarSessions() {
  const { data: authSession } = useAuthSession();
  const { mutate: mutateCache } = useSWRConfig();
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

  // Rows as the server sent them. A root that appears in several loaded
  // pages renders only in the newest of them.
  const fetchedCategoryItems = useMemo(() => {
    const results = [
      { firstPageItems: attention.firstPageItems, loadedPages: attention.loadedPages },
      { firstPageItems: inProgress.firstPageItems, loadedPages: inProgress.loadedPages },
      { firstPageItems: finished.firstPageItems, loadedPages: finished.loadedPages },
    ];
    const latestTailSequence = new Map<string, number>();
    for (const result of results) {
      for (const { page, sequence } of result.loadedPages) {
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
        ...result.loadedPages.flatMap(({ page, sequence }) =>
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
    attention.firstPageItems,
    attention.loadedPages,
    canonicalRootIds,
    finished.firstPageItems,
    finished.loadedPages,
    inProgress.firstPageItems,
    inProgress.loadedPages,
  ]);

  const overlay = useSessionReadOverlay();
  useEffect(() => {
    scopeSessionReadOverlay(userId);
  }, [userId]);
  useEffect(() => {
    pruneSessionReadOverlay(
      fetchedCategoryItems.flat().flatMap((item) => [item.rootSession, ...item.descendantSessions])
    );
  }, [fetchedCategoryItems]);

  // Reads this page established are merged over the fetched rows at render.
  // The server places sessions; the client only stops showing a hierarchy in
  // attention once the viewer has read all of it.
  const [attentionItems, inProgressItems, finishedItems] = useMemo(() => {
    const [attentionRows, inProgressRows, finishedRows] = fetchedCategoryItems.map((items) =>
      items.map((item) => applySessionReadOverlay(item, overlay))
    );
    return [
      attentionRows.filter((item) => !isSessionInboxItemFullyRead(item)),
      inProgressRows,
      finishedRows,
    ];
  }, [fetchedCategoryItems, overlay]);

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

  const removeFromAttention = attention.removeSession;
  const removeFromInProgress = inProgress.removeSession;
  const removeFromFinished = finished.removeSession;
  const handleSessionArchived = useCallback(
    async (sessionId: string) => {
      removeFromAttention(sessionId);
      removeFromInProgress(sessionId);
      removeFromFinished(sessionId);
      void refreshInbox().catch((error) => {
        console.error("Failed to refresh session inbox after archive", error);
      });
    },
    [refreshInbox, removeFromAttention, removeFromFinished, removeFromInProgress]
  );

  const handleMarkLatestMessageRead = useCallback(
    async (sessionId: string) => {
      if (!userId) return;
      scopeSessionReadOverlay(userId);
      const result = await markLatestMessageRead(sessionId);
      applySessionReadResult(result, mutateCache, userId);
    },
    [mutateCache, userId]
  );

  return {
    needsAttention: attentionItems.map((item) => item.rootSession),
    inProgress: inProgressItems.map((item) => item.rootSession),
    finished: finishedItems.map((item) => item.rootSession),
    childrenMap,
    loading: sessionCreatorFilter === null || isLoading,
    sessionsError: snapshotError ?? categoryResults.find((result) => result.error)?.error,
    refreshSnapshot,
    // Keyed by SessionInboxCategory, in camelCase. These used to be `running`
    // and `recent` here and `in_progress`/`finished` everywhere else, so the
    // render site had to translate between the two -- the same session and
    // sandbox vocabularies getting mixed that this module now keeps apart.
    sectionPagination: {
      needsAttention: attention,
      inProgress,
      finished,
    },
    sessionCreatorFilter,
    setSessionCreatorFilter,
    handleSessionArchived,
    handleMarkLatestMessageRead,
  };
}
