"use client";

import Link from "next/link";
import { useState } from "react";
import useSWR from "swr";
import {
  teamSessionsResponseSchema,
  type TeamSessionsResponse,
} from "@open-inspect/shared/types/teams";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import { useAuthSession } from "@/lib/auth-session";
import { Button } from "@/components/ui/button";
import { ErrorBanner } from "@/components/ui/error-banner";
import { formatRelativeTime } from "@/lib/time";

const TEAM_SESSIONS_REFRESH_MS = 30_000;
type TeamSessionPage = Extract<TeamSessionsResponse, { items: unknown }>;

class TeamSessionsRequestError extends Error {
  constructor(readonly status: number) {
    super(`Unable to load team sessions (${status})`);
  }
}

export function useTeamSessionBucket(teamId: string, bucket: "needs_attention" | "in_progress") {
  const { data: session } = useAuthSession();
  const userId = session?.user.id;
  const identity = JSON.stringify([userId, teamId, bucket]);
  const [pagination, setPagination] = useState({ identity, cursors: [] as string[] });
  const cursors = pagination.identity === identity ? pagination.cursors : [];
  if (pagination.identity !== identity) setPagination({ identity, cursors: [] });
  const params = new URLSearchParams({ bucket });
  const cursor = cursors.at(-1);
  if (cursor) params.set("cursor", cursor);
  const key: BrowserApiPath = `/api/teams/${encodeURIComponent(teamId)}/sessions?${params.toString()}`;
  const result = useSWR<TeamSessionPage, Error>(
    userId ? ([key, userId] as const) : null,
    async ([path]: readonly [BrowserApiPath, string]) => {
      const response = await browserApiFetch(path);
      if (!response.ok) throw new TeamSessionsRequestError(response.status);
      const page = teamSessionsResponseSchema.parse(await response.json());
      if (!("items" in page)) throw new Error("Expected a team session bucket page");
      return page;
    },
    { refreshInterval: TEAM_SESSIONS_REFRESH_MS, keepPreviousData: false }
  );
  const accessDenied =
    result.error instanceof TeamSessionsRequestError &&
    [401, 403, 404].includes(result.error.status);
  const data = userId && !accessDenied ? result.data : undefined;
  return {
    items: data?.items ?? [],
    loading: result.isLoading,
    validating: result.isValidating,
    error: result.error,
    page: cursors.length + 1,
    hasPrevious: cursors.length > 0,
    hasMore: data?.hasMore ?? false,
    previous: () => setPagination({ identity, cursors: cursors.slice(0, -1) }),
    next: () => {
      if (!data?.hasMore) return;
      setPagination({ identity, cursors: [...cursors, data.nextCursor] });
    },
    refresh: () => result.mutate(),
  };
}

export function TeamOverview({ teamId }: { teamId: string }) {
  const attention = useTeamSessionBucket(teamId, "needs_attention");
  const progress = useTeamSessionBucket(teamId, "in_progress");
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Team work</h2>
        <Button
          size="sm"
          variant="outline"
          disabled={attention.validating || progress.validating}
          onClick={() => void Promise.all([attention.refresh(), progress.refresh()])}
        >
          Refresh
        </Button>
      </div>
      <SessionBucket title="Needs attention" bucket={attention} />
      <SessionBucket title="In progress" bucket={progress} />
    </div>
  );
}

function SessionBucket({
  title,
  bucket,
}: {
  title: string;
  bucket: ReturnType<typeof useTeamSessionBucket>;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {bucket.error && (
        <ErrorBanner role="alert">
          Unable to load {title.toLowerCase()} sessions.{" "}
          <Button size="xs" variant="outline" onClick={() => void bucket.refresh()}>
            Retry
          </Button>
        </ErrorBanner>
      )}
      {bucket.loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading sessions...
        </p>
      ) : bucket.items.length === 0 && !bucket.error ? (
        <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
          No sessions {title.toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y divide-border-muted rounded-md border border-border-muted">
          {bucket.items.map(({ rootSession, descendantSessions }) => (
            <li key={rootSession.id} className="p-4">
              {[rootSession, ...descendantSessions].map((session, index) => (
                <div
                  key={session.id}
                  className={index > 0 ? "ml-4 mt-3 border-l border-border pl-3" : ""}
                >
                  {session.capabilities.canRead ? (
                    <Link
                      href={`/session/${encodeURIComponent(session.id)}`}
                      className="break-words text-sm font-medium text-foreground hover:underline"
                    >
                      {session.title ?? "Untitled session"}
                    </Link>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {session.title ?? "Untitled session"}
                    </span>
                  )}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {session.status} / {formatRelativeTime(session.updatedAt)}
                  </p>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {(bucket.hasMore || bucket.hasPrevious) && (
        <nav aria-label={`${title} pagination`} className="flex items-center justify-between gap-3">
          <Button
            size="sm"
            variant="outline"
            disabled={!bucket.hasPrevious || bucket.loading || bucket.validating}
            onClick={bucket.previous}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            Page {bucket.page}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!bucket.hasMore || bucket.loading || bucket.validating || !!bucket.error}
            onClick={bucket.next}
          >
            Next
          </Button>
        </nav>
      )}
    </section>
  );
}
