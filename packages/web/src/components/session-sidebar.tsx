"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect, useMemo } from "react";
import { useSession, signOut } from "next-auth/react";
import { formatRelativeTime, isInactiveSession } from "@/lib/time";
import { Button } from "@/components/ui/button";

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
  onSessionSelect?: () => void;
}

export function SessionSidebar({ onNewSession, onToggle, onSessionSelect }: SessionSidebarProps) {
  const { data: authSession, status } = useSession();
  const pathname = usePathname();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // use status as dep instead of authSession object (unstable reference)
  const isAuthenticated = status === "authenticated";
  useEffect(() => {
    if (isAuthenticated) {
      fetchSessions();
    }
  }, [isAuthenticated]);

  // listen for real-time title updates from the session websocket
  useEffect(() => {
    const handler = (e: Event) => {
      const { sessionId, title } = (e as CustomEvent).detail;
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title } : s))
      );
    };
    window.addEventListener("session-title-updated", handler);
    return () => window.removeEventListener("session-title-updated", handler);
  }, []);

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

  // sort sessions by updatedAt (most recent first) and filter by search query
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

    // sort by updatedAt descending
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
    <aside className="w-[284px] h-screen flex flex-col bg-black">
      {/* header */}
      <div className="flex items-center justify-between py-5 px-5">
        <Link href="/" className="flex items-center gap-2.5">
          <WrenchIcon />
          <span className="text-sm font-semibold text-white">Wrench</span>
        </Link>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="xs"
            onClick={onNewSession}
            className="p-1.5 h-auto text-ash-400 hover:text-white hover:bg-ash-800"
            title="New session"
          >
            <PlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={onToggle}
            className="p-1.5 h-auto text-ash-400 hover:text-white hover:bg-ash-800"
            title="Toggle sidebar"
          >
            <SidebarIcon />
          </Button>
        </div>
      </div>

      {/* search */}
      <div className="px-4 pb-3">
        <input
          type="text"
          placeholder="Search sessions..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm bg-ash-800 border border-ash-700 rounded-lg text-white placeholder:text-ash-500 focus:outline-none focus:ring-1 focus:ring-rebolt-500 focus:border-transparent"
        />
      </div>

      {/* session list */}
      <div className="flex-1 overflow-y-auto scrollbar-none">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-ash-400" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-ash-500">No sessions yet</div>
        ) : (
          <>
            {/* active sessions */}
            {activeSessions.map((session) => (
              <SessionListItem
                key={session.id}
                session={session}
                isActive={session.id === currentSessionId}
                onSessionSelect={onSessionSelect}
              />
            ))}

            {/* inactive divider */}
            {inactiveSessions.length > 0 && (
              <>
                <div className="px-4 py-3">
                  <div className="h-px bg-white/15" />
                </div>
                <div className="px-5 pb-2">
                  <span className="text-xs font-medium text-ash-500 uppercase tracking-wide">
                    Inactive
                  </span>
                </div>
                {inactiveSessions.map((session) => (
                  <SessionListItem
                    key={session.id}
                    session={session}
                    isActive={session.id === currentSessionId}
                    onSessionSelect={onSessionSelect}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* footer */}
      <div className="flex items-center justify-between p-4 border-t border-ash-700">
        <div className="flex items-center gap-2 min-w-0">
          {authSession?.user?.image ? (
            <img
              src={authSession.user.image}
              alt={authSession.user.name || "User"}
              className="w-8 h-8 rounded-full shrink-0"
            />
          ) : (
            <div className="w-8 h-8 rounded-full bg-ash-700 flex items-center justify-center text-xs font-medium text-white shrink-0">
              {authSession?.user?.name?.charAt(0).toUpperCase() || "?"}
            </div>
          )}
          <span className="text-sm font-semibold text-white truncate">
            {authSession?.user?.name || "User"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            asChild
            variant="ghost"
            size="xs"
            className={`p-1.5 h-auto ${
              pathname === "/settings"
                ? "text-white bg-ash-700"
                : "text-ash-400 hover:text-white hover:bg-ash-800"
            }`}
          >
            <Link href="/settings" title="Settings">
              <SettingsIcon />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => signOut()}
            className="p-1.5 h-auto text-ash-400 hover:text-white hover:bg-ash-800"
            title="Sign out"
          >
            <SignOutIcon />
          </Button>
        </div>
      </div>
    </aside>
  );
}

function SessionListItem({
  session,
  isActive,
  onSessionSelect,
}: {
  session: SessionItem;
  isActive: boolean;
  onSessionSelect?: () => void;
}) {
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);
  const displayTitle = session.title || `${session.repoOwner}/${session.repoName}`;
  const repoInfo = `${session.repoOwner}/${session.repoName}`;

  return (
    <Link
      href={`/session/${session.id}`}
      onClick={() => {
        if (window.matchMedia("(max-width: 767px)").matches) {
          onSessionSelect?.();
        }
      }}
      className={`block mx-2 mb-0.5 px-3 py-2.5 rounded-lg transition-colors ${
        isActive ? "bg-ash-700 text-white" : "text-ash-400 hover:bg-ash-800 hover:text-ash-300"
      }`}
    >
      <div className="flex items-center gap-2">
        {isActive && <div className="w-1 h-4 rounded-full bg-rebolt-500 shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{displayTitle}</div>
          <div className="flex items-center gap-1 mt-0.5 text-xs text-ash-500">
            <span>{relativeTime}</span>
            <span>·</span>
            <span className="truncate">{repoInfo}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function WrenchIcon() {
  return (
    <svg
      className="w-5 h-5 text-rebolt-500"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
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

function SignOutIcon() {
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
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
