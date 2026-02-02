"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { useSession, signOut } from "next-auth/react";
import { formatRelativeTime, isInactiveSession } from "@/lib/time";

export interface SessionItem {
  id: string;
  title: string | null;
  repoOwner: string;
  repoName: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface SessionSidebarProps {
  onNewSession?: () => void;
  onToggle?: () => void;
}

export function SessionSidebar({ onNewSession, onToggle }: SessionSidebarProps) {
  const { data: authSession } = useSession();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    if (authSession) {
      fetchSessions();
    }
  }, [authSession]);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (error) {
      console.error("Failed to fetch sessions:", error);
    } finally {
      setLoading(false);
    }
  };

  // Sort sessions by updatedAt (most recent first) and filter by search query
  const { activeSessions, inactiveSessions } = useMemo(() => {
    const filtered = sessions.filter((session) => {
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
    <aside className="w-72 h-screen flex flex-col border-r border-border-muted bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted">
        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
            title="Toggle sidebar"
          >
            <SidebarIcon />
          </button>
          <Link href="/" className="flex items-center gap-2">
            <InspectIcon />
            <span className="font-semibold text-foreground">Inspect</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onNewSession}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted transition"
            title="New session"
          >
            <PlusIcon />
          </button>
          <Link
            href="/settings"
            className={`p-1.5 transition ${
              pathname === "/settings"
                ? "text-foreground bg-muted"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            title="Settings"
          >
            <SettingsIcon />
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

function SessionListItem({ session, isActive }: { session: SessionItem; isActive: boolean }) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || `${session.repoOwner}/${session.repoName}`;
  const repoInfo = `${session.repoOwner}/${session.repoName}`;

  return (
    <Link
      href={`/session/${session.id}`}
      className={`block px-4 py-2.5 border-l-2 transition ${
        isActive ? "border-l-accent bg-accent-muted" : "border-l-transparent hover:bg-muted"
      }`}
    >
      <div className="truncate text-sm font-medium text-foreground">{displayTitle}</div>
      <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
        <span>{relativeTime}</span>
        <span>·</span>
        <span className="truncate">{repoInfo}</span>
      </div>
    </Link>
  );
}

function InspectIcon() {
  return (
    <svg
      className="w-5 h-5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function SidebarIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
