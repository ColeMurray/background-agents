"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatRepoLabel } from "@/lib/repo-label";
import {
  buildSessionHref,
  buildSessionsPageKey,
  fetchSessionListPage,
  isUnarchivedSessionListKey,
  removeSessionFromList,
  type SessionListItem,
  type SessionListResponse,
} from "@/lib/session-list";
import { formatRelativeTime } from "@/lib/time";
import { browserApiFetch } from "@/lib/browser-api-fetch";
import { sessionActionErrorMessage } from "@/lib/session-action-error";
import { resolveSessionCapabilities } from "@/lib/session-capabilities";

const PAGE_SIZE = 20;
const ARCHIVED_SESSIONS_KEY = buildSessionsPageKey({
  status: "archived",
  limit: PAGE_SIZE,
  offset: 0,
});

export function DataControlsSettings() {
  const [extraSessions, setExtraSessions] = useState<SessionListItem[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);

  const { data, isLoading: loading } = useSWR<SessionListResponse>(
    ARCHIVED_SESSIONS_KEY,
    fetchSessionListPage,
    {
      onSuccess: (data) => {
        setHasMore(data.hasMore);
        offsetRef.current = data.sessions.length;
        setExtraSessions([]);
      },
    }
  );

  const firstPageSessions = data?.sessions ?? [];
  const sessions = [...firstPageSessions, ...extraSessions];

  const handleLoadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const page = await fetchSessionListPage(
        buildSessionsPageKey({
          status: "archived",
          limit: PAGE_SIZE,
          offset: offsetRef.current,
        })
      );
      setExtraSessions((prev) => [...prev, ...page.sessions]);
      setHasMore(page.hasMore);
      offsetRef.current += page.sessions.length;
    } catch (error) {
      console.error("Failed to fetch archived sessions:", error);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  const handleUnarchive = async (sessionId: string) => {
    try {
      const res = await browserApiFetch(`/api/sessions/${sessionId}/unarchive`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error(await sessionActionErrorMessage(res, "Failed to unarchive session"));
        return;
      }
      toast.success("Session unarchived");
      await mutate<SessionListResponse>(
        ARCHIVED_SESSIONS_KEY,
        (current) =>
          current
            ? { ...current, sessions: removeSessionFromList(current.sessions, sessionId) }
            : current,
        { revalidate: false, populateCache: true }
      );
      setExtraSessions((prev) => prev.filter((s) => s.id !== sessionId));
      // Server-side list shifts down by one, so the next Load more must
      // start one offset earlier to avoid skipping the session that took
      // this row's slot.
      offsetRef.current -= 1;
      mutate(isUnarchivedSessionListKey);
    } catch {
      toast.error("Failed to unarchive session");
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
          {loading ? (
            <span
              className="inline-block h-3.5 w-36 align-middle bg-muted rounded animate-pulse motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : sessionCount === 0 ? (
            "No archived sessions"
          ) : (
            `${sessionCount}${hasMore ? "+" : ""} archived session${sessionCount !== 1 ? "s" : ""}`
          )}
        </p>

        {loading ? (
          <ArchivedSessionsSkeleton />
        ) : sessions.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No archived sessions. Sessions you archive will appear here.
          </div>
        ) : (
          <div className="border border-border rounded-md divide-y divide-border-muted">
            {sessions.map((session) => (
              <ArchivedSessionRow
                key={session.id}
                session={session}
                canUnarchive={resolveSessionCapabilities(session.capabilities).lifecycle}
                onUnarchive={handleUnarchive}
              />
            ))}
          </div>
        )}

        {hasMore && !loading && (
          <Button
            variant="outline"
            size="sm"
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

const SKELETON_ROW_COUNT = 3;

/** Mirrors ArchivedSessionRow: a title line over a timestamp · repo line. */
function ArchivedSessionsSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading archived sessions"
      className="border border-border rounded-md divide-y divide-border-muted animate-pulse motion-reduce:animate-none"
    >
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <div key={index} className="px-4 py-3">
          <div className="h-4 w-56 max-w-full my-0.5 bg-muted rounded" />
          <div className="h-3 w-40 max-w-full mt-1.5 mb-0.5 bg-muted rounded" />
        </div>
      ))}
    </div>
  );
}

function ArchivedSessionRow({
  session,
  canUnarchive,
  onUnarchive,
}: {
  session: SessionListItem;
  canUnarchive: boolean;
  onUnarchive: (id: string) => void;
}) {
  const repoInfo = formatRepoLabel(session.repoOwner, session.repoName);
  const displayTitle = session.title || repoInfo;
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
      {canUnarchive && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => onUnarchive(session.id)}
          className="flex-shrink-0 opacity-0 group-hover:opacity-100"
        >
          Unarchive
        </Button>
      )}
    </div>
  );
}
