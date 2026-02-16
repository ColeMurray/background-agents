"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import type { SessionItem } from "@/components/session-sidebar";
import { formatRelativeTime } from "@/lib/time";
import { Button } from "@/components/ui/button";

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
      <h2 className="text-xl font-semibold text-ash-900 mb-1">Data Controls</h2>
      <p className="text-sm text-ash-500 mb-6">Manage your archived chats and data.</p>

      <div>
        <h3 className="text-base font-medium text-ash-900 mb-1">Archived chats</h3>
        <p className="text-sm text-ash-500 mb-4">
          {loading
            ? "Loading..."
            : sessionCount === 0
              ? "No archived sessions"
              : `${sessionCount}${hasMore ? "+" : ""} archived session${sessionCount !== 1 ? "s" : ""}`}
        </p>

        {loading ? (
          <div className="flex justify-center py-8">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-ash-400" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="py-8 text-center text-sm text-ash-500">
            No archived sessions. Sessions you archive will appear here.
          </div>
        ) : (
          <div className="border border-ash-200 rounded-lg divide-y divide-ash-200">
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
          <Button
            variant="rebolt-outline"
            size="xs"
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="mt-4 w-full"
          >
            {loadingMore ? "Loading..." : "Load more"}
          </Button>
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
    <div className="group flex items-center justify-between px-4 py-3 hover:bg-ash-100 transition-colors">
      <Link href={`/session/${session.id}`} className="flex-1 min-w-0 mr-3">
        <div className="truncate text-sm font-medium text-ash-900">{displayTitle}</div>
        <div className="flex items-center gap-1 mt-0.5 text-xs text-ash-500">
          <span>{relativeTime}</span>
          <span>&middot;</span>
          <span className="truncate">{repoInfo}</span>
        </div>
      </Link>
      <Button
        variant="rebolt-outline"
        size="xs"
        onClick={() => onUnarchive(session.id)}
        className="flex-shrink-0 opacity-0 group-hover:opacity-100"
      >
        Unarchive
      </Button>
    </div>
  );
}
