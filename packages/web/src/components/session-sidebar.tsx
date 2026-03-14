"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSession, signOut } from "next-auth/react";
import useSWR, { mutate } from "swr";
import { formatRelativeTime, isInactiveSession } from "@/lib/time";
import {
  buildSessionsPageKey,
  mergeUniqueSessions,
  SIDEBAR_SESSIONS_KEY,
  type SessionListResponse,
} from "@/lib/session-list";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  MoreIcon,
  SidebarIcon,
  InspectIcon,
  PlusIcon,
  SettingsIcon,
  AutomationsIcon,
  BranchIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

type SessionsResponse = { sessions: SessionItem[] };

export function buildSessionHref(session: SessionItem) {
  return {
    pathname: `/session/${session.id}`,
    query: {
      repoOwner: session.repoOwner,
      repoName: session.repoName,
      ...(session.title ? { title: session.title } : {}),
    },
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
  const [searchQuery, setSearchQuery] = useState("");
  const [extraSessions, setExtraSessions] = useState<SessionItem[]>([]);
  const [hasMorePages, setHasMorePages] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const isMobile = useIsMobile();

  const { data, isLoading: loading } = useSWR<SessionListResponse>(
    authSession ? SIDEBAR_SESSIONS_KEY : null
  );
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
    if (!data) return;

    setExtraSessions([]);
    setHasMorePages(data.hasMore);
    setLoadingMore(false);
    offsetRef.current = firstPageSessions.length;
    hasMoreRef.current = data.hasMore;
    loadingMoreRef.current = false;
  }, [data, firstPageSessions.length]);

  const loadMoreSessions = useCallback(async () => {
    if (!authSession || loadingMoreRef.current || !hasMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);

    try {
      const response = await fetch(
        buildSessionsPageKey({ excludeStatus: "archived", offset: offsetRef.current })
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch additional sessions: ${response.status}`);
      }

      const page: SessionListResponse = await response.json();
      const fetched = page.sessions ?? [];

      setExtraSessions((prev) => mergeUniqueSessions(prev, fetched));
      setHasMorePages(page.hasMore);
      offsetRef.current += fetched.length;
      hasMoreRef.current = page.hasMore;
    } catch (error) {
      console.error("Failed to fetch additional sessions:", error);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [authSession]);

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
  const { activeSessions, inactiveSessions, childrenMap } = useMemo(() => {
    const filtered = sessions
      .filter((session) => session.status !== "archived")
      .filter((session) => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        const title = session.title?.toLowerCase() || "";
        const repo = `${session.repoOwner}/${session.repoName}`.toLowerCase();
        return title.includes(query) || repo.includes(query);
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

    for (const session of topLevel) {
      const timestamp = session.updatedAt || session.createdAt;
      if (isInactiveSession(timestamp)) {
        inactive.push(session);
      } else {
        active.push(session);
      }
    }

    return { activeSessions: active, inactiveSessions: inactive, childrenMap: children };
  }, [sessions, searchQuery]);

  const currentSessionId = pathname?.startsWith("/session/") ? pathname.split("/")[2] : null;

  return (
    <aside className="w-72 h-dvh flex flex-col border-r border-border-muted bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            title={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
            aria-label={`Toggle sidebar (${SHORTCUT_LABELS.TOGGLE_SIDEBAR})`}
          >
            <SidebarIcon className="w-4 h-4" />
          </Button>
          <Link href="/" className="flex items-center gap-2">
            <InspectIcon className="w-5 h-5" />
            <span className="font-semibold text-foreground">Inspect</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
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
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md transition ${
            pathname?.startsWith("/automations")
              ? "text-foreground bg-muted"
              : "text-muted-foreground hover:text-foreground hover:bg-muted"
          }`}
        >
          <AutomationsIcon className="w-4 h-4" />
          Automations
        </Link>
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
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">No sessions yet</div>
        ) : (
          <>
            {/* Active Sessions */}
            {activeSessions.map((session) => (
              <SessionWithChildren
                key={session.id}
                session={session}
                childSessions={childrenMap.get(session.id)}
                currentSessionId={currentSessionId}
                isMobile={isMobile}
                onSessionSelect={onSessionSelect}
              />
            ))}

            {/* Inactive Divider */}
            {inactiveSessions.length > 0 && (
              <>
                <div className="px-4 py-2 mt-2">
                  <span className="text-xs font-medium text-secondary-foreground uppercase tracking-wide">
                    Inactive
                  </span>
                </div>
                {inactiveSessions.map((session) => (
                  <SessionWithChildren
                    key={session.id}
                    session={session}
                    childSessions={childrenMap.get(session.id)}
                    currentSessionId={currentSessionId}
                    isMobile={isMobile}
                    onSessionSelect={onSessionSelect}
                  />
                ))}
              </>
            )}

            {loadingMore && (
              <div className="flex justify-center py-3">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-muted-foreground" />
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
  childSessions,
  currentSessionId,
  isMobile,
  onSessionSelect,
}: {
  session: SessionItem;
  childSessions?: SessionItem[];
  currentSessionId: string | null;
  isMobile: boolean;
  onSessionSelect?: () => void;
}) {
  return (
    <>
      <SessionListItem
        session={session}
        isActive={session.id === currentSessionId}
        isMobile={isMobile}
        onSessionSelect={onSessionSelect}
      />
      {childSessions &&
        childSessions.map((child) => (
          <ChildSessionListItem
            key={child.id}
            session={child}
            isActive={child.id === currentSessionId}
            isMobile={isMobile}
            onSessionSelect={onSessionSelect}
          />
        ))}
    </>
  );
}

function SessionListItem({
  session,
  isActive,
  isMobile,
  onSessionSelect,
}: {
  session: SessionItem;
  isActive: boolean;
  isMobile: boolean;
  onSessionSelect?: () => void;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || `${session.repoOwner}/${session.repoName}`;
  const repoInfo = `${session.repoOwner}/${session.repoName}`;
  // Orphan child (parent filtered out) — show a subtle badge
  const isOrphanChild = session.parentSessionId && session.spawnSource === "agent";
  const [isRenaming, setIsRenaming] = useState(false);
  const [title, setTitle] = useState(displayTitle);

  useEffect(() => {
    if (!isRenaming) {
      setTitle(displayTitle);
    }
  }, [displayTitle, isRenaming]);

  const handleStartRename = () => {
    setTitle(displayTitle);
    setIsRenaming(true);
  };

  const handleCancelRename = () => {
    setTitle(displayTitle);
    setIsRenaming(false);
  };

  const handleRenameSubmit = async () => {
    const trimmed = title.trim();

    if (!trimmed || trimmed === displayTitle) {
      setIsRenaming(false);
      return;
    }

    const previousTitle = displayTitle;
    setIsRenaming(false);

    const updateSessionsTitle = (data?: SessionsResponse): SessionsResponse => ({
      sessions: (data?.sessions ?? []).map((currentSession) =>
        currentSession.id === session.id
          ? {
              ...currentSession,
              title: trimmed,
              updatedAt: Date.now(),
            }
          : currentSession
      ),
    });

    try {
      await mutate<SessionsResponse>(
        "/api/sessions",
        async (currentData?: SessionsResponse) => {
          const response = await fetch(`/api/sessions/${session.id}/title`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: trimmed }),
          });
          if (!response.ok) {
            throw new Error("Failed to update session title");
          }
          return updateSessionsTitle(currentData);
        },
        {
          optimisticData: updateSessionsTitle,
          rollbackOnError: true,
          populateCache: true,
          revalidate: true,
        }
      );
    } catch {
      setTitle(previousTitle);
      setIsRenaming(true);
    }
  };

  return (
    <div
      className={`group relative block px-4 py-2.5 border-l-2 transition ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
    >
      {isRenaming ? (
        <>
          <input
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
          onClick={() => {
            if (isMobile) {
              onSessionSelect?.();
            }
          }}
          className="block pr-8"
        >
          <div className="truncate text-sm font-medium text-foreground">{displayTitle}</div>
          <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
            <span>{relativeTime}</span>
            <span>·</span>
            <span className="truncate">{repoInfo}</span>
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Session actions"
              className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreIcon className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleStartRename}>Rename</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ChildSessionListItem({
  session,
  isActive,
  isMobile,
  onSessionSelect,
}: {
  session: SessionItem;
  isActive: boolean;
  isMobile: boolean;
  onSessionSelect?: () => void;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || "Sub-task";
  return (
    <Link
      href={buildSessionHref(session)}
      onClick={() => {
        if (isMobile) {
          onSessionSelect?.();
        }
      }}
      className={`block pl-7 pr-4 py-1.5 border-l-2 transition ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
    >
      <div className="flex items-center gap-1.5 text-xs">
        <span className="shrink-0 text-muted-foreground">{relativeTime}</span>
        <span className="truncate font-medium text-foreground">{displayTitle}</span>
      </div>
    </Link>
  );
}
