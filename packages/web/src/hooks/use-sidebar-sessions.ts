"use client";

import { useRouter } from "next/navigation";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import useSWR, { mutate } from "swr";
import { isInactiveSession } from "@/lib/time";
import {
  applyTitleUpdate,
  applySessionUnread,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  isUnarchivedSessionListKey,
  mergeUniqueSessions,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import type { Session } from "@open-inspect/shared";
import { markSessionRead, reconcileSessionUnread } from "@/lib/session-read-state";

const VISIBLE_SESSION_LIST_POLL_MS = 30_000;

export type SessionItem = Session;

type SessionCreatorFilter = "all" | "mine";

export function useSidebarSessions(currentSessionId: string | null) {
  const { data: authSession } = useAuthSession();
  const router = useRouter();
  const [sessionCreatorFilter, setSessionCreatorFilter] = useState<SessionCreatorFilter>("all");
  const [extraSessionsState, setExtraSessionsState] = useState<{
    key: string | null;
    sessions: SessionItem[];
  }>({ key: null, sessions: [] });
  const [hasMorePages, setHasMorePages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [navigationOverrides, setNavigationOverrides] = useState(
    new Map<string, { unread: boolean; source: SessionListResponse | undefined }>()
  );
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
    mutate: mutateSidebarSessions,
  } = useSWR<SessionListResponse>(sidebarSessionsKey, {
    refreshInterval: () =>
      typeof document !== "undefined" && document.visibilityState === "visible"
        ? VISIBLE_SESSION_LIST_POLL_MS
        : 0,
    refreshWhenHidden: false,
  });
  const dataRef = useRef(data);
  dataRef.current = data;
  const loading = sessionsLoading;
  const firstPageSessions = useMemo(() => data?.sessions ?? [], [data?.sessions]);

  // Pagination belongs to the filter key, not a particular first-page object.
  // Polling replaces that object every 30 seconds and must not collapse rows
  // the user has already loaded.
  const extraSessions = useMemo(
    () => (extraSessionsState.key === sidebarSessionsKey ? extraSessionsState.sessions : []),
    [extraSessionsState, sidebarSessionsKey]
  );

  useEffect(() => {
    sessionListVersionRef.current += 1;
    setExtraSessionsState({ key: sidebarSessionsKey, sessions: [] });
    setNavigationOverrides(new Map());
    setLoadingMore(false);
    loadingMoreRef.current = false;
  }, [sidebarSessionsKey]);

  useEffect(() => {
    sessionListVersionRef.current += 1;
    setLoadingMore(false);
    loadingMoreRef.current = false;

    if (extraSessions.length === 0) {
      const nextHasMore = data?.hasMore ?? false;
      setHasMorePages(nextHasMore);
      hasMoreRef.current = nextHasMore;
    }
    offsetRef.current = data ? firstPageSessions.length + extraSessions.length : 0;
  }, [data, extraSessions.length, firstPageSessions.length]);

  const loadMoreSessions = useCallback(async () => {
    if (!authSession || !sidebarSessionsKey || loadingMoreRef.current || !hasMoreRef.current) {
      return;
    }

    loadingMoreRef.current = true;
    setLoadingMore(true);
    const sessionListVersion = sessionListVersionRef.current;

    try {
      const response = await browserApiFetch(
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
        key: sidebarSessionsKey,
        sessions: mergeUniqueSessions(
          previous.key === sidebarSessionsKey ? previous.sessions : [],
          fetched
        ),
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
  }, [authSession, sessionCreatorFilter, sidebarSessionsKey]);

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

  const sessions = useMemo(() => {
    return mergeUniqueSessions(firstPageSessions, extraSessions).map((session) => {
      const override = navigationOverrides.get(session.id);
      if (override && override.source === data) {
        return { ...session, navigation: { unread: override.unread } };
      }
      return session;
    });
  }, [data, extraSessions, firstPageSessions, navigationOverrides]);

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

  const handleSessionMarkedRead = useCallback(
    async (sessionId: string) => {
      const dataAtStart = dataRef.current;
      const result = await markSessionRead(sessionId);
      await mutateSidebarSessions(
        (current) => applySessionUnread(current, result.sessionId, result.unread),
        { revalidate: false }
      );
      await reconcileSessionUnread(result);
      setExtraSessionsState((previous) => ({
        ...previous,
        sessions: previous.sessions.map((session) =>
          session.id === sessionId ? { ...session, navigation: { unread: result.unread } } : session
        ),
      }));
      if (dataRef.current === dataAtStart) {
        setNavigationOverrides((previous) => {
          const next = new Map(previous);
          next.set(sessionId, { unread: result.unread, source: dataAtStart });
          return next;
        });
      }
    },
    [mutateSidebarSessions]
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
    handleSessionMarkedRead,
  };
}
