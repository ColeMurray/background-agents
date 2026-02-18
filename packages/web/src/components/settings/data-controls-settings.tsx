"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import useSWR, { mutate } from "swr";
import { buildSessionHref, type SessionItem } from "@/components/session-sidebar";
import { formatRelativeTime } from "@/lib/time";

const PAGE_SIZE = 20;
const ARCHIVED_SESSIONS_KEY = `/api/sessions?status=archived&limit=${PAGE_SIZE}&offset=0`;

export function DataControlsSettings() {
  const [extraSessions, setExtraSessions] = useState<SessionItem[]>([]);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const { data, isLoading: loading } = useSWR<{ sessions: SessionItem[] }>(ARCHIVED_SESSIONS_KEY, {
    onSuccess: (data) => {
      const fetched = data.sessions || [];
      setHasMore(fetched.length === PAGE_SIZE);
      setOffset(fetched.length);
      setExtraSessions([]);
      setHiddenIds(new Set());
    },
  });

  const firstPageSessions = data?.sessions ?? [];
  const sessions = [...firstPageSessions, ...extraSessions].filter((s) => !hiddenIds.has(s.id));

  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/sessions?status=archived&limit=${PAGE_SIZE}&offset=${offset}`);
      if (res.ok) {
        const resData = await res.json();
        const fetched: SessionItem[] = resData.sessions || [];
        setExtraSessions((prev) => [...prev, ...fetched]);
        setHasMore(fetched.length === PAGE_SIZE);
        setOffset((prev) => prev + fetched.length);
      }
    } catch (error) {
      console.error("Failed to fetch archived sessions:", error);
    } finally {
      setLoadingMore(false);
    }
  }, [offset]);

  const handleUnarchive = async (sessionId: string) => {
    // Optimistically hide from both first-page and extra sessions
    setHiddenIds((prev) => new Set(prev).add(sessionId));
    try {
      const res = await fetch(`/api/sessions/${sessionId}/unarchive`, { method: "POST" });
      if (res.ok) {
        mutate("/api/sessions");
        mutate(ARCHIVED_SESSIONS_KEY);
      } else {
        mutate(ARCHIVED_SESSIONS_KEY);
      }
    } catch {
      mutate(ARCHIVED_SESSIONS_KEY);
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
      <Link href={buildSessionHref(session)} className="flex-1 min-w-0 mr-3">
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
