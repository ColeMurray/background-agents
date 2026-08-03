"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAuthSession } from "@/lib/auth-session";
import useSWR, { mutate } from "swr";
import useSWRInfinite from "swr/infinite";
import { isInactiveSession } from "@/lib/time";
import {
  applyTitleUpdate,
  applySessionReadState,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  isUnarchivedSessionListKey,
  mergeUniqueSessions,
  removeSessionFromList,
  SESSIONS_PAGE_SIZE,
  type SessionListResponse,
} from "@/lib/session-list";
import type { Session } from "@open-inspect/shared";
import {
  markLatestMessageRead,
  reconcileSessionReadState,
  readStateFromResult,
} from "@/lib/session-read-state";

const VISIBLE_SESSION_LIST_POLL_MS = 30_000;

export type SessionItem = Session;

type SessionCreatorFilter = "all" | "mine";

export function useSidebarSessions(currentSessionId: string | null) {
  const { data: authSession } = useAuthSession();
  const router = useRouter();
  const [sessionCreatorFilter, setSessionCreatorFilter] = useState<SessionCreatorFilter>("all");
  const [extraPageRequest, setExtraPageRequest] = useState({
    key: null as string | null,
    count: 0,
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const sidebarSessionListOptions = useMemo(
    () => ({
      excludeStatus: "archived",
      ...(sessionCreatorFilter === "mine"
        ? {
            excludeAutomationLineage: true,
            createdBy: [CURRENT_USER_CREATED_BY],
          }
        : {}),
    }),
    [sessionCreatorFilter]
  );

  const sidebarSessionsKey = useMemo(() => {
    if (!authSession) return null;

    return buildSessionsPageKey(sidebarSessionListOptions);
  }, [authSession, sidebarSessionListOptions]);
  const {
    data: firstPage,
    error: sessionsError,
    isLoading: sessionsLoading,
    mutate: mutateFirstPage,
  } = useSWR<SessionListResponse>(sidebarSessionsKey, {
    refreshInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "visible"
        ? VISIBLE_SESSION_LIST_POLL_MS
        : 0,
    refreshWhenHidden: false,
  });
  const requestedExtraPages =
    extraPageRequest.key === sidebarSessionsKey ? extraPageRequest.count : 0;

  const getExtraPageKey = useCallback(
    (pageIndex: number, previousPage: SessionListResponse | null) => {
      if (
        !authSession ||
        pageIndex >= requestedExtraPages ||
        !firstPage?.hasMore ||
        (previousPage && !previousPage.hasMore)
      ) {
        return null;
      }
      return buildSessionsPageKey({
        ...sidebarSessionListOptions,
        offset: (pageIndex + 1) * SESSIONS_PAGE_SIZE,
      });
    },
    [authSession, firstPage?.hasMore, requestedExtraPages, sidebarSessionListOptions]
  );

  const {
    data: extraPages,
    isValidating,
    size,
    setSize,
    mutate: mutateExtraPages,
  } = useSWRInfinite<SessionListResponse>(getExtraPageKey, {
    refreshInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "visible"
        ? VISIBLE_SESSION_LIST_POLL_MS
        : 0,
    refreshWhenHidden: false,
    revalidateAll: true,
  });
  const loading = sessionsLoading;
  const loadingMore = isValidating && extraPages?.[size - 1] === undefined;
  const hasMorePages = extraPages?.at(-1)?.hasMore ?? firstPage?.hasMore ?? false;

  const loadMoreSessions = useCallback(async () => {
    if (!authSession || !sidebarSessionsKey || loadingMore || !hasMorePages) return;
    const nextPageCount = requestedExtraPages + 1;
    setExtraPageRequest({ key: sidebarSessionsKey, count: nextPageCount });
    await setSize(nextPageCount);
  }, [authSession, hasMorePages, loadingMore, requestedExtraPages, setSize, sidebarSessionsKey]);

  const maybeLoadMoreSessions = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 96;
    if (nearBottom) {
      void loadMoreSessions();
    }
  }, [loadMoreSessions]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || loading || loadingMore || !hasMorePages) return;

    if (container.clientHeight > 0 && container.scrollHeight <= container.clientHeight) {
      void loadMoreSessions();
    }
  }, [hasMorePages, loading, loadingMore, loadMoreSessions, extraPages, firstPage]);

  const sessions = useMemo(() => {
    return (extraPages ?? []).reduce<SessionItem[]>(
      (all, page) => mergeUniqueSessions(all, page?.sessions ?? []),
      firstPage?.sessions ?? []
    );
  }, [extraPages, firstPage?.sessions]);

  // Sort sessions by updatedAt (most recent first) and group children under their parent sessions.
  const { activeSessions, inactiveSessions, childrenMap } = useMemo(() => {
    const filtered = sessions.filter((session) => session.status !== "archived");

    // Sort by updatedAt descending
    const sorted = [...filtered].sort((a, b) => {
      const aTime = a.updatedAt || a.createdAt;
      const bTime = b.updatedAt || b.createdAt;
      return bTime - aTime;
    });

    // Build set of visible session IDs for orphan detection
    const visibleIds = new Set(sorted.map((s) => s.id));

    // Group children by parent ID
    const children = new Map<string, SessionItem[]>();
    const topLevel: SessionItem[] = [];

    for (const session of sorted) {
      const parentId = session.parentSessionId;
      if (parentId && visibleIds.has(parentId)) {
        // Parent is visible — nest under it
        const siblings = children.get(parentId) ?? [];
        siblings.push(session);
        children.set(parentId, siblings);
      } else {
        // Top-level session (or orphan child whose parent is filtered out)
        topLevel.push(session);
      }
    }

    const active: SessionItem[] = [];
    const inactive: SessionItem[] = [];
    const now = Date.now();

    for (const session of topLevel) {
      const timestamp = session.updatedAt || session.createdAt;
      if (isInactiveSession(timestamp, now)) {
        inactive.push(session);
      } else {
        active.push(session);
      }
    }

    return {
      activeSessions: active,
      inactiveSessions: inactive,
      childrenMap: children,
    };
  }, [sessions]);

  const handleSessionArchived = useCallback(
    async (sessionId: string) => {
      await Promise.all([
        mutateFirstPage(
          (current) =>
            current
              ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
              : current,
          { revalidate: false }
        ),
        mutateExtraPages(
          (current) =>
            current?.map((page) => ({
              ...page,
              sessions: removeSessionFromList(page.sessions, sessionId),
            })),
          { revalidate: false }
        ),
      ]);
      await mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (current) =>
          current
            ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
            : current,
        { revalidate: false, populateCache: true }
      );

      if (currentSessionId === sessionId) {
        router.push("/");
      }
    },
    [currentSessionId, mutateExtraPages, mutateFirstPage, router]
  );

  const handleSessionRenamed = useCallback(
    (sessionId: string, title: string) => {
      const updatedAt = Date.now();
      void mutateFirstPage((current) => applyTitleUpdate(current, sessionId, title, updatedAt), {
        revalidate: false,
      });
      void mutateExtraPages(
        (current) =>
          current?.map((page) => applyTitleUpdate(page, sessionId, title, updatedAt) ?? page),
        { revalidate: false }
      );

      void mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (currentData) => applyTitleUpdate(currentData, sessionId, title, updatedAt),
        { revalidate: false }
      );
    },
    [mutateExtraPages, mutateFirstPage]
  );

  const handleMarkLatestMessageRead = useCallback(
    async (sessionId: string) => {
      const result = await markLatestMessageRead(sessionId);
      const readState = readStateFromResult(result);
      await mutateFirstPage(
        (current) => applySessionReadState(current, result.sessionId, readState),
        { revalidate: false }
      );
      await mutateExtraPages(
        (current) =>
          current?.map((page) => applySessionReadState(page, result.sessionId, readState) ?? page),
        { revalidate: false }
      );
      await reconcileSessionReadState(result);
    },
    [mutateExtraPages, mutateFirstPage]
  );

  return {
    sessions,
    activeSessions,
    inactiveSessions,
    childrenMap,
    loading,
    loadingMore,
    sessionsError,
    sessionCreatorFilter,
    setSessionCreatorFilter,
    scrollContainerRef,
    maybeLoadMoreSessions,
    handleSessionArchived,
    handleSessionRenamed,
    handleMarkLatestMessageRead,
  };
}
