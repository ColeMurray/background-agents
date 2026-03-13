"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useMemo, useRef, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import useSWR from "swr";
import { formatRelativeTime, isInactiveSession } from "@/lib/time";
import { SHORTCUT_LABELS } from "@/lib/keyboard-shortcuts";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  SidebarIcon,
  InspectIcon,
  PlusIcon,
  SettingsIcon,
  AutomationsIcon,
  BranchIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import type { Session } from "@open-inspect/shared";

export type SessionItem = Session;

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
  const isMobile = useIsMobile();

  const { data, isLoading: loading } = useSWR<{ sessions: SessionItem[] }>(
    authSession ? "/api/sessions" : null
  );
  const sessions = useMemo(() => data?.sessions ?? [], [data]);

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
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-input border border-border focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent placeholder:text-secondary-foreground text-foreground"
        />
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto">
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
          </>
        )}
      </div>
    </aside>
  );
}

function UserMenu({ user }: { user?: { name?: string | null; image?: string | null } | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function toggle() {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setMenuPos({
        top: rect.bottom + 4,
        left: rect.left,
      });
    }
    setOpen((v) => !v);
  }

  return (
    <>
      <button
        ref={buttonRef}
        onClick={toggle}
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
      {open && menuPos && (
        <div
          ref={menuRef}
          className="fixed w-48 rounded-md border border-border bg-background shadow-lg py-1 z-[100]"
          style={{ top: menuPos.top, left: menuPos.left }}
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-sm font-medium text-foreground truncate">{user?.name || "User"}</p>
          </div>
          <button
            onClick={() => signOut()}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3-3l3-3m0 0l-3-3m3 3H9" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </>
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
  return (
    <Link
      href={buildSessionHref(session)}
      onClick={() => {
        if (isMobile) {
          onSessionSelect?.();
        }
      }}
      className={`block px-4 py-2.5 border-l-2 transition ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
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
