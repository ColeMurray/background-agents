"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import useSWR, { mutate } from "swr";
import { isInactiveSession } from "@/lib/time";
import {
  applyTitleUpdate,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  isUnarchivedSessionListKey,
  mergeUniqueSessions,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import type { Session } from "@open-inspect/shared";

export type SessionItem = Session;

type SessionCreatorFilter = "all" | "mine";

export function useSidebarSessions(currentSessionId: string | null) {
  const { data: authSession } = useSession();
  const router = useRouter();
  const [sessionCreatorFilter, setSessionCreatorFilter] = useState<SessionCreatorFilter>("all");
  const [extraSessionsState, setExtraSessionsState] = useState<{
    source: SessionListResponse | undefined;
    sessions: SessionItem[];
  }>({ source: undefined, sessions: [] });
  const [hasMorePages, setHasMorePages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const sessionListVersionRef = useRef(0);

  const sidebarSessionsKey = useMemo(() => {
    if (!authSession) return null;

    return buildSessionsPageKey({
      excludeStatus: "archived",
      createdBy: sessionCreatorFilter === "mine" ? [CURRENT_USER_CREATED_BY] : undefined,
    });
  }, [authSession, sessionCreatorFilter]);

  const {
    data,
    error: sessionsError,
    isLoading: sessionsLoading,
  } = useSWR<SessionListResponse>(sidebarSessionsKey);
  const loading = sessionsLoading;
  const firstPageSessions = useMemo(() => data?.sessions ?? [], [data?.sessions]);

  // Hide paginated rows synchronously when SWR replaces their source page.
  const extraSessions = useMemo(
    () => (extraSessionsState.source === data ? extraSessionsState.sessions : []),
    [data, extraSessionsState]
  );

  useEffect(() => {
    sessionListVersionRef.current += 1;
    setExtraSessionsState({ source: data, sessions: [] });
    setLoadingMore(false);
    loadingMoreRef.current = false;

    const nextHasMore = data?.hasMore ?? false;
    const nextOffset = data ? firstPageSessions.length : 0;

    setHasMorePages(nextHasMore);
    offsetRef.current = nextOffset;
    hasMoreRef.current = nextHasMore;
  }, [sidebarSessionsKey, data, firstPageSessions.length]);

  const loadMoreSessions = useCallback(async () => {
    if (!authSession || !sidebarSessionsKey || loadingMoreRef.current || !hasMoreRef.current) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const sessionListVersion = sessionListVersionRef.current;

    try {
      const response = await fetch(
        buildSessionsPageKey({
          excludeStatus: "archived",
          createdBy: sessionCreatorFilter === "mine" ? [CURRENT_USER_CREATED_BY] : undefined,
          offset: offsetRef.current,
        })
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch additional sessions: ${response.status}`);
      }

      const page: SessionListResponse = await response.json();
      const fetched = page.sessions ?? [];

      if (sessionListVersion !== sessionListVersionRef.current) {
        return;
      }

      setExtraSessionsState((previous) => ({
        source: data,
        sessions: mergeUniqueSessions(previous.source === data ? previous.sessions : [], fetched),
      }));
      setHasMorePages(page.hasMore);
      offsetRef.current += fetched.length;
      hasMoreRef.current = page.hasMore;
    } catch (error) {
      console.error("Failed to fetch additional sessions:", error);
    } finally {
      if (sessionListVersion === sessionListVersionRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [authSession, data, sessionCreatorFilter, sidebarSessionsKey]);

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
  }, [
    hasMorePages,
    loading,
    loadingMore,
    loadMoreSessions,
    firstPageSessions.length,
    extraSessions.length,
  ]);

  const sessions = useMemo(
    () => mergeUniqueSessions(firstPageSessions, extraSessions),
    [firstPageSessions, extraSessions]
  );

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
      if (!sidebarSessionsKey) return;

      await mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (current) =>
          current
            ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
            : current,
        { revalidate: false, populateCache: true }
      );
      setExtraSessionsState((previous) => ({
        ...previous,
        sessions: previous.sessions.filter((session) => session.id !== sessionId),
      }));

      if (currentSessionId === sessionId) {
        router.push("/");
      }
    },
    [currentSessionId, router, sidebarSessionsKey]
  );

  const handleSessionRenamed = useCallback(
    (sessionId: string, title: string) => {
      const updatedAt = Date.now();
      setExtraSessionsState((previous) => ({
        ...previous,
        sessions: previous.sessions.map((session) =>
          session.id === sessionId ? { ...session, title, updatedAt } : session
        ),
      }));
      if (!sidebarSessionsKey) return;

      void mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (currentData) => applyTitleUpdate(currentData, sessionId, title, updatedAt),
        { revalidate: false }
      );
    },
    [sidebarSessionsKey]
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
  };
}
