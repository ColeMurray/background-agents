"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useMemo } from "react";
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
  BranchIcon,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";

export interface SessionItem {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  baseBranch: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  spawnSource?: "user" | "agent";
}

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

  // Sort sessions by updatedAt (most recent first) and filter by search query
  const { activeSessions, inactiveSessions } = useMemo(() => {
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

    const active: SessionItem[] = [];
    const inactive: SessionItem[] = [];

    for (const session of sorted) {
      const timestamp = session.updatedAt || session.createdAt;
      if (isInactiveSession(timestamp)) {
        inactive.push(session);
      } else {
        active.push(session);
      }
    }

    return { activeSessions: active, inactiveSessions: inactive };
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
          {authSession?.user?.image ? (
            <button
              onClick={() => signOut()}
              className="w-7 h-7 rounded-full overflow-hidden"
              title={`Signed in as ${authSession.user.name}\nClick to sign out`}
            >
              <img
                src={authSession.user.image}
                alt={authSession.user.name || "User"}
                className="w-full h-full object-cover"
              />
            </button>
          ) : (
            <button
              onClick={() => signOut()}
              className="w-7 h-7 rounded-full bg-card flex items-center justify-center text-xs font-medium text-foreground"
              title="Sign out"
            >
              {authSession?.user?.name?.charAt(0).toUpperCase() || "?"}
            </button>
          )}
        </div>
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
              <SessionListItem
                key={session.id}
                session={session}
                isActive={session.id === currentSessionId}
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
                  <SessionListItem
                    key={session.id}
                    session={session}
                    isActive={session.id === currentSessionId}
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
        {session.spawnSource === "agent" && (
          <>
            <span>·</span>
            <span>Sub-task</span>
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
