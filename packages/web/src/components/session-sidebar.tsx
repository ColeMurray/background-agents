"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Fragment,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type TouchEvent,
} from "react";
import { useSession, signOut } from "next-auth/react";
import useSWR, { mutate } from "swr";
import { ArchiveSessionDialog } from "@/components/archive-session-dialog";
import { archiveSession } from "@/lib/archive-session";
import { pullRequestSummaryDisplay } from "@/lib/pr-summary";
import { PullRequestStateIcon } from "@/components/pr-state-icon";
import { formatRelativeTime, isInactiveSession } from "@/lib/time";
import {
  applyTitleUpdate,
  buildSessionsPageKey,
  CURRENT_USER_CREATED_BY,
  isUnarchivedSessionListKey,
  mergeUniqueSessions,
  removeSessionFromList,
  type SessionListResponse,
} from "@/lib/session-list";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  MoreIcon,
  SidebarIcon,
  ArchiveIcon,
  PlusIcon,
  SettingsIcon,
  AutomationsIcon,
  BranchIcon,
  BoxIcon,
  DataControlsIcon,
} from "@/components/ui/icons";
import { APP_SHORT_NAME } from "@/lib/site-config";
import { formatRepoLabel, formatSessionRepositoriesLabel } from "@/lib/repo-label";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEnvironments } from "@/hooks/use-environments";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Session } from "@open-inspect/shared";

export type SessionItem = Session;

export const MOBILE_LONG_PRESS_MS = 450;
const MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX = 10;
type SessionCreatorFilter = "all" | "mine";

export function buildSessionHref(session: SessionItem) {
  const query: Record<string, string> = {};
  if (session.repoOwner && session.repoName) {
    query.repoOwner = session.repoOwner;
    query.repoName = session.repoName;
  }
  if (session.title) {
    query.title = session.title;
  }

  return {
    pathname: `/session/${session.id}`,
    query,
  };
}

interface SessionSidebarProps {
  onNewSession?: () => void;
  onToggle?: () => void;
  onSessionSelect?: () => void;
}

export function SessionSidebar({ onNewSession, onToggle, onSessionSelect }: SessionSidebarProps) {
  const { data: authSession } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useState("");
  const [sessionCreatorFilter, setSessionCreatorFilter] = useState<SessionCreatorFilter>("all");
  const [extraSessions, setExtraSessions] = useState<SessionItem[]>([]);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const sessionListVersionRef = useRef(0);
  const isMobile = useIsMobile();

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

  // Track data reference to clear extraSessions synchronously during render,
  // preventing one frame of stale extra sessions after SWR revalidation.
  const prevDataRef = useRef(data);
  let effectiveExtraSessions = extraSessions;
  if (prevDataRef.current !== data) {
    prevDataRef.current = data;
    effectiveExtraSessions = [];
  }

  useEffect(() => {
    sessionListVersionRef.current += 1;
    setExtraSessions([]);
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

      setExtraSessions((prev) => mergeUniqueSessions(prev, fetched));
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

  const sessions = useMemo(
    () => mergeUniqueSessions(firstPageSessions, effectiveExtraSessions),
    [firstPageSessions, effectiveExtraSessions]
  );

  // Sort sessions by updatedAt (most recent first), filter by search query,
  // and group children under their parent sessions
  const { activeSessions, inactiveSessions, childrenMap, hasFilteredSessions } = useMemo(() => {
    const filtered = sessions
      .filter((session) => session.status !== "archived")
      .filter((session) => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        const title = session.title?.toLowerCase() || "";
        if (title.includes(query)) return true;
        // Match against every member of the repository set, not just the
        // primary; scalar fallback covers pre-multi-repo sessions.
        const repoLabels = session.repositories?.length
          ? session.repositories.map((repo) => formatRepoLabel(repo.repoOwner, repo.repoName))
          : [formatRepoLabel(session.repoOwner, session.repoName)];
        return repoLabels.some((label) => label.toLowerCase().includes(query));
      });

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
      hasFilteredSessions: filtered.length > 0,
    };
  }, [sessions, searchQuery]);

  // Environment provenance for the cards, resolved once for the whole list.
  // Names are looked up so a deleted environment (or one still loading)
  // simply drops the chip instead of showing a raw id.
  const { environments } = useEnvironments();
  const environmentNamesById = useMemo(
    () => new Map(environments.map((environment) => [environment.id, environment.name])),
    [environments]
  );

  const currentSessionId = pathname?.startsWith("/session/") ? pathname.split("/")[2] : null;
  const hasSessionListError = sessionsError;
  const emptyMessage = hasSessionListError
    ? "Unable to load sessions"
    : sessionCreatorFilter === "mine"
      ? "No sessions started by you"
      : "No sessions yet";

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
      setExtraSessions((prev) => prev.filter((session) => session.id !== sessionId));

      if (currentSessionId === sessionId) {
        router.push("/");
      }
    },
    [currentSessionId, router, sidebarSessionsKey]
  );

  const handleNavigationSelect = useCallback(() => {
    if (isMobile) {
      onSessionSelect?.();
    }
  }, [isMobile, onSessionSelect]);

  const handleSessionRenamed = useCallback(
    (sessionId: string, title: string) => {
      const updatedAt = Date.now();
      setExtraSessions((prev) =>
        prev.map((session) =>
          session.id === sessionId ? { ...session, title, updatedAt } : session
        )
      );
      if (!sidebarSessionsKey) return;

      void mutate<SessionListResponse>(
        isUnarchivedSessionListKey,
        (currentData) => applyTitleUpdate(currentData, sessionId, title, updatedAt),
        { revalidate: false }
      );
    },
    [sidebarSessionsKey]
  );

  return (
    <aside className="w-72 h-dvh flex flex-col border-r border-border-muted bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            title={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            aria-label={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
          >
            <SidebarIcon className="w-4 h-4" />
          </Button>
          <Link href="/" onClick={handleNavigationSelect} className="min-w-0">
            <span className="block truncate font-semibold text-foreground">{APP_SHORT_NAME}</span>
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewSession}
            title={`New session (${SHORTCUT_LABELS.NEW_SESSION})`}
            aria-label={`New session (${SHORTCUT_LABELS.NEW_SESSION})`}
          >
            <PlusIcon className="w-4 h-4" />
          </Button>
          <Link
            href="/settings"
            onClick={handleNavigationSelect}
            className={`p-1.5 transition ${
              pathname === "/settings"
                ? "text-foreground bg-muted"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            title="Settings"
          >
            <SettingsIcon className="w-4 h-4" />
          </Link>
          <UserMenu user={authSession?.user} />
        </div>
      </div>

      {/* Nav links */}
      <div className="px-3 pt-2 pb-1 flex flex-col gap-0.5">
        <Link
          href="/automations"
          onClick={handleNavigationSelect}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition ${
            pathname?.startsWith("/automations")
              ? "text-foreground bg-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <AutomationsIcon className="w-4 h-4" />
          Automations
        </Link>
        <Link
          href="/analytics"
          onClick={handleNavigationSelect}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition ${
            pathname?.startsWith("/analytics")
              ? "text-foreground bg-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <DataControlsIcon className="w-4 h-4" />
          Analytics
        </Link>
      </div>

      <div className="px-3 pt-2">
        <ToggleGroup
          type="single"
          value={sessionCreatorFilter}
          onValueChange={(value) => {
            if (value === "all" || value === "mine") {
              setSessionCreatorFilter(value);
            }
          }}
          className="grid grid-cols-2 rounded-md border border-border-muted bg-muted p-0.5"
          aria-label="Session owner filter"
        >
          <ToggleGroupItem
            value="all"
            className="h-7 rounded-sm text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            All
          </ToggleGroupItem>
          <ToggleGroupItem
            value="mine"
            className="h-7 rounded-sm text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            Mine
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* Search */}
      <div className="px-3 py-2">
        <Input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      {/* Session List */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
        onScroll={maybeLoadMoreSessions}
      >
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">{emptyMessage}</div>
        ) : searchQuery && !hasFilteredSessions ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No matching sessions
          </div>
        ) : (
          <>
            {/* Active Sessions */}
            {activeSessions.map((session) => (
              <SessionWithChildren
                key={session.id}
                session={session}
                environmentName={
                  session.environmentId
                    ? environmentNamesById.get(session.environmentId)
                    : undefined
                }
                childrenMap={childrenMap}
                currentSessionId={currentSessionId}
                isMobile={isMobile}
                onArchive={handleSessionArchived}
                onSessionSelect={onSessionSelect}
                onSessionRenamed={handleSessionRenamed}
              />
            ))}

            {/* Inactive Divider */}
            {inactiveSessions.length > 0 && (
              <>
                <div className="px-4 py-2 mt-2">
                  <span className="text-xs font-medium text-secondary-foreground uppercase tracking-wider">
                    Inactive
                  </span>
                </div>
                {inactiveSessions.map((session) => (
                  <SessionWithChildren
                    key={session.id}
                    session={session}
                    environmentName={
                      session.environmentId
                        ? environmentNamesById.get(session.environmentId)
                        : undefined
                    }
                    childrenMap={childrenMap}
                    currentSessionId={currentSessionId}
                    isMobile={isMobile}
                    onArchive={handleSessionArchived}
                    onSessionSelect={onSessionSelect}
                    onSessionRenamed={handleSessionRenamed}
                  />
                ))}
              </>
            )}

            {loadingMore && (
              <div className="flex justify-center py-3">
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent text-muted-foreground" />
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function UserMenu({ user }: { user?: { name?: string | null; image?: string | null } | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="w-7 h-7 rounded-full overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary"
          aria-label={`Signed in as ${user?.name || "User"}`}
          title={`Signed in as ${user?.name || "User"}`}
        >
          {user?.image ? (
            <img
              src={user.image}
              alt={user.name || "User"}
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="w-full h-full rounded-full bg-card flex items-center justify-center text-xs font-medium text-foreground">
              {user?.name?.charAt(0).toUpperCase() || "?"}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        <DropdownMenuLabel className="font-medium truncate">
          {user?.name || "User"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut()}>
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3-3l3-3m0 0l-3-3m3 3H9"
            />
          </svg>
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionWithChildren({
  session,
  environmentName,
  childrenMap,
  currentSessionId,
  isMobile,
  onArchive,
  onSessionSelect,
  onSessionRenamed,
}: {
  session: SessionItem;
  environmentName?: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onSessionRenamed: (sessionId: string, title: string) => void;
}) {
  return (
    <>
      <SessionListItem
        session={session}
        environmentName={environmentName}
        isActive={session.id === currentSessionId}
        isMobile={isMobile}
        onArchive={onArchive}
        onSessionSelect={onSessionSelect}
        onSessionRenamed={onSessionRenamed}
      />
      <ChildSessionTree
        parentId={session.id}
        childrenMap={childrenMap}
        currentSessionId={currentSessionId}
        isMobile={isMobile}
        onSessionSelect={onSessionSelect}
        visitedIds={new Set([session.id])}
      />
    </>
  );
}

function ChildSessionTree({
  parentId,
  childrenMap,
  currentSessionId,
  isMobile,
  onSessionSelect,
  visitedIds,
  depth = 1,
}: {
  parentId: string;
  childrenMap: Map<string, SessionItem[]>;
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
  visitedIds: Set<string>;
  depth?: number;
}) {
  const childSessions = childrenMap.get(parentId);
  if (!childSessions?.length) return null;

  return childSessions.map((child) => {
    if (visitedIds.has(child.id)) return null;

    const nextVisitedIds = new Set(visitedIds);
    nextVisitedIds.add(child.id);

    return (
      <Fragment key={child.id}>
        <ChildSessionListItem
          session={child}
          isActive={child.id === currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          depth={depth}
        />
        <ChildSessionTree
          parentId={child.id}
          childrenMap={childrenMap}
          currentSessionId={currentSessionId}
          isMobile={isMobile}
          onSessionSelect={onSessionSelect}
          visitedIds={nextVisitedIds}
          depth={depth + 1}
        />
      </Fragment>
    );
  });
}

function SessionListItem({
  session,
  environmentName,
  isActive,
  isMobile,
  onArchive,
  onSessionSelect,
  onSessionRenamed,
}: {
  session: SessionItem;
  environmentName?: string;
  isActive: boolean;
  isMobile: boolean;
  onArchive: (sessionId: string) => Promise<void>;
  onSessionSelect?: () => void;
  onSessionRenamed: (sessionId: string, title: string) => void;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const repoInfo = formatSessionRepositoriesLabel(
    session.repoOwner,
    session.repoName,
    session.repositories
  );
  const prDisplay = pullRequestSummaryDisplay(session.pullRequestSummary);
  const displayTitle = session.title || repoInfo;
  // Orphan child (parent filtered out) — show a subtle badge
  const isOrphanChild = session.parentSessionId && session.spawnSource === "agent";
  const [isRenaming, setIsRenaming] = useState(false);
  const [isActionsOpen, setIsActionsOpen] = useState(false);
  const [isArchiving, setIsArchiving] = useState(false);
  const [showArchiveDialog, setShowArchiveDialog] = useState(false);
  const [title, setTitle] = useState(displayTitle);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isStartingRenameRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isRenaming) {
      setTitle(displayTitle);
    }
  }, [displayTitle, isRenaming]);

  const handleStartRename = () => {
    isStartingRenameRef.current = true;
    setIsActionsOpen(false);
    setTitle(displayTitle);
    setIsRenaming(true);
  };

  useEffect(() => {
    if (!isRenaming) return;

    const timeout = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [isRenaming]);

  const handleCancelRename = () => {
    setTitle(displayTitle);
    setIsRenaming(false);
  };

  const handleStartArchive = () => {
    setIsActionsOpen(false);
    setShowArchiveDialog(true);
  };

  const handleConfirmArchive = async () => {
    setShowArchiveDialog(false);
    setIsArchiving(true);

    try {
      const didArchive = await archiveSession(session.id);
      if (didArchive) {
        await onArchive(session.id);
      }
    } finally {
      setIsArchiving(false);
    }
  };

  const handleRenameSubmit = async () => {
    const trimmed = title.trim();

    if (!trimmed || trimmed === displayTitle) {
      setIsRenaming(false);
      return;
    }

    const previousTitle = displayTitle;
    setIsRenaming(false);

    try {
      const response = await fetch(`/api/sessions/${session.id}/title`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!response.ok) {
        throw new Error("Failed to update session title");
      }
      onSessionRenamed(session.id, trimmed);
    } catch {
      setTitle(previousTitle);
      setIsRenaming(true);
    }
  };

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchStart = useCallback(
    (event: TouchEvent<HTMLAnchorElement>) => {
      if (!isMobile) return;

      const touch = event.touches[0];
      if (!touch) return;

      longPressTriggeredRef.current = false;
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
      clearLongPressTimer();
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTriggeredRef.current = true;
        setIsActionsOpen(true);
      }, MOBILE_LONG_PRESS_MS);
    },
    [clearLongPressTimer, isMobile]
  );

  const handleTouchMove = useCallback(
    (event: TouchEvent<HTMLAnchorElement>) => {
      if (!isMobile) return;

      const start = touchStartRef.current;
      const touch = event.touches[0];
      if (!start || !touch) return;

      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (Math.hypot(deltaX, deltaY) > MOBILE_LONG_PRESS_MOVE_THRESHOLD_PX) {
        clearLongPressTimer();
      }
    },
    [clearLongPressTimer, isMobile]
  );

  const handleTouchEnd = useCallback(() => {
    clearLongPressTimer();
    touchStartRef.current = null;
  }, [clearLongPressTimer]);

  useEffect(() => {
    return () => clearLongPressTimer();
  }, [clearLongPressTimer]);

  return (
    <>
      <div
        className={`group relative block px-4 py-2.5 border-l-2 transition ${
          isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
        }`}
      >
        {isRenaming ? (
          <>
            <input
              ref={renameInputRef}
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onFocus={(e) => e.currentTarget.select()}
              onBlur={handleRenameSubmit}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  handleCancelRename();
                }
              }}
              className="w-full text-sm bg-transparent text-foreground outline-none focus:ring-inset focus:ring-ring font-medium pr-8"
            />
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <span>{relativeTime}</span>
              <span>·</span>
              <span className="truncate">{repoInfo}</span>
            </div>
          </>
        ) : (
          <Link
            href={buildSessionHref(session)}
            onClick={(event) => {
              if (longPressTriggeredRef.current) {
                event.preventDefault();
                longPressTriggeredRef.current = false;
                return;
              }
              if (isMobile) {
                onSessionSelect?.();
              }
            }}
            onContextMenu={(event) => {
              if (isMobile) {
                event.preventDefault();
              }
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            className="block pr-8"
          >
            <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              {prDisplay && (
                <PullRequestStateIcon state={prDisplay.state} label={prDisplay.label} />
              )}
              <span className="truncate">{displayTitle}</span>
            </div>
            <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
              <span>{relativeTime}</span>
              <span>·</span>
              <span className="truncate">{repoInfo}</span>
              {environmentName && (
                <>
                  <span>·</span>
                  <BoxIcon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{environmentName}</span>
                </>
              )}
              {isOrphanChild && (
                <>
                  <span>·</span>
                  <span className="text-accent">sub-task</span>
                </>
              )}
              {session.baseBranch && session.baseBranch !== "main" && (
                <>
                  <span>·</span>
                  <BranchIcon className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">{session.baseBranch}</span>
                </>
              )}
            </div>
          </Link>
        )}

        <div className="absolute inset-y-0 right-2 flex items-start pt-2">
          <DropdownMenu open={isActionsOpen} onOpenChange={setIsActionsOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Session actions"
                aria-hidden={isMobile ? "true" : undefined}
                tabIndex={isMobile ? -1 : undefined}
                className={`h-6 w-6 items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition data-[state=open]:opacity-100 ${
                  isMobile
                    ? "pointer-events-none flex opacity-0"
                    : "flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                }`}
              >
                <MoreIcon className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              onCloseAutoFocus={(event) => {
                if (isStartingRenameRef.current) {
                  event.preventDefault();
                  isStartingRenameRef.current = false;
                }
              }}
            >
              <DropdownMenuItem onSelect={handleStartRename}>Rename</DropdownMenuItem>
              <DropdownMenuItem onClick={handleStartArchive} disabled={isArchiving}>
                <ArchiveIcon className="w-4 h-4" />
                Archive
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <ArchiveSessionDialog
        open={showArchiveDialog}
        onOpenChange={setShowArchiveDialog}
        onConfirm={handleConfirmArchive}
      />
    </>
  );
}

function ChildSessionListItem({
  session,
  isActive,
  isMobile,
  onSessionSelect,
  depth,
}: {
  session: SessionItem;
  isActive: boolean;
  isMobile: boolean;
  onSessionSelect?: () => void;
  depth: number;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || "Sub-task";
  const paddingLeftRem = 1.75 + Math.max(depth - 1, 0) * 1;
  return (
    <Link
      href={buildSessionHref(session)}
      onClick={() => {
        if (isMobile) {
          onSessionSelect?.();
        }
      }}
      className={`block pr-4 py-1.5 border-l-2 transition ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
      style={{ paddingLeft: `${paddingLeftRem}rem` }}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span className="shrink-0 text-muted-foreground">{relativeTime}</span>
        <span className="truncate font-medium text-foreground">{displayTitle}</span>
      </div>
    </Link>
  );
}
