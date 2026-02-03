"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { SessionItem } from "@/components/session-sidebar";
import { formatRelativeTime } from "@/lib/time";

const PAGE_SIZE = 20;

export function DataControlsSettings() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const fetchArchivedSessions = useCallback(async (currentOffset: number, append: boolean) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch(
        `/api/sessions?status=archived&limit=${PAGE_SIZE}&offset=${currentOffset}`
      );
      if (res.ok) {
        const data = await res.json();
        const fetched: SessionItem[] = data.sessions || [];
        setSessions((prev) => (append ? [...prev, ...fetched] : fetched));
        setHasMore(fetched.length === PAGE_SIZE);
        setOffset(currentOffset + fetched.length);
      }
    } catch (error) {
      console.error("Failed to fetch archived sessions:", error);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    fetchArchivedSessions(0, false);
  }, [fetchArchivedSessions]);

  const handleLoadMore = () => {
    fetchArchivedSessions(offset, true);
  };

  const handleUnarchive = async (sessionId: string) => {
    // Optimistically remove from list
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/unarchive`, { method: "POST" });
      if (!res.ok) {
        // Re-fetch on failure to restore correct state
        fetchArchivedSessions(0, false);
      }
    } catch {
      fetchArchivedSessions(0, false);
    }
  };

  const sessionCount = sessions.length;

  return (
    <div>
      <h2 className="text-xl font-semibold text-foreground mb-1">Data Controls</h2>
      <p className="text-sm text-muted-foreground mb-6">Manage your archived chats and data.</p>

      <div>
        <h3 className="text-base font-medium text-foreground mb-1">Archived chats</h3>
        <p className="text-sm text-muted-foreground mb-4">
          {loading
            ? "Loading..."
            : sessionCount === 0
              ? "No archived sessions"
              : `${sessionCount}${hasMore ? "+" : ""} archived session${sessionCount !== 1 ? "s" : ""}`}
        </p>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No archived sessions. Sessions you archive will appear here.
          </div>
        ) : (
          <div className="border border-border rounded divide-y divide-border">
            {sessions.map((session) => (
              <ArchivedSessionRow
                key={session.id}
                session={session}
                onUnarchive={handleUnarchive}
              />
            ))}
          </div>
        )}

        {hasMore && !loading && (
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="mt-4 w-full py-2 text-sm text-muted-foreground hover:text-foreground border border-border rounded hover:bg-muted transition disabled:opacity-50"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}

function ArchivedSessionRow({
  session,
  onUnarchive,
}: {
  session: SessionItem;
  onUnarchive: (id: string) => void;
}) {
  const displayTitle = session.title || `${session.repoOwner}/${session.repoName}`;
  const repoInfo = `${session.repoOwner}/${session.repoName}`;
  const timestamp = session.updatedAt || session.createdAt;
  const relativeTime = formatRelativeTime(timestamp);

  return (
    <div className="group flex items-center justify-between px-4 py-3 hover:bg-muted transition">
      <Link href={`/session/${session.id}`} className="flex-1 min-w-0 mr-3">
        <div className="truncate text-sm font-medium text-foreground">{displayTitle}</div>
        <div className="flex items-center gap-1 mt-0.5 text-xs text-muted-foreground">
          <span>{relativeTime}</span>
          <span>&middot;</span>
          <span className="truncate">{repoInfo}</span>
        </div>
      </Link>
      <button
        onClick={() => onUnarchive(session.id)}
        className="flex-shrink-0 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground border border-border rounded hover:bg-background transition opacity-0 group-hover:opacity-100"
      >
        Unarchive
      </button>
    </div>
  );
}
