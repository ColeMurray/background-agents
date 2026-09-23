"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { BoxIcon } from "@/components/ui/icons";
import { formatRelativeTime } from "@/lib/time";
import {
  SESSION_ORIGIN_LABELS,
  SESSION_STATUS_LABELS,
  sessionRepositoryLabels,
} from "@/lib/session-discovery";
import { buildSessionHref, type SessionListItem } from "@/lib/session-list";

const UNTITLED_SESSION_LABEL = "Untitled session";
/** Members shown inline before the rest collapse into a "+N" count. */
const INLINE_REPOSITORY_LABELS = 2;

function formatCreator(session: SessionListItem, currentUserId: string | null): string | null {
  if (currentUserId && session.userId === currentUserId) return "you";
  return session.scmLogin ?? null;
}

interface SessionDiscoveryRowProps {
  session: SessionListItem;
  environmentName: string | undefined;
  currentUserId: string | null;
}

/**
 * One compact result row. The whole row is a link to the session detail
 * page, so it reads as one entry to a screen reader and takes one tab stop.
 */
function SessionDiscoveryRow({
  session,
  environmentName,
  currentUserId,
}: SessionDiscoveryRowProps) {
  const repositoryLabels = sessionRepositoryLabels(session);
  const inlineRepositories = repositoryLabels.slice(0, INLINE_REPOSITORY_LABELS);
  const hiddenRepositories = repositoryLabels.slice(INLINE_REPOSITORY_LABELS);
  const creator = formatCreator(session, currentUserId);
  const isArchived = session.status === "archived";

  return (
    <li>
      <Link
        href={buildSessionHref(session)}
        className="block px-4 py-3 transition hover:bg-muted focus-visible:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
      >
        <div className="flex items-start justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {session.title || UNTITLED_SESSION_LABEL}
          </span>
          <Badge
            variant={isArchived ? "default" : session.status === "failed" ? "pr-closed" : "default"}
            className="shrink-0"
          >
            {SESSION_STATUS_LABELS[session.status]}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {inlineRepositories.map((label) => (
            <span key={label} className="truncate">
              {label}
            </span>
          ))}
          {hiddenRepositories.length > 0 && (
            <span title={hiddenRepositories.join(", ")}>+{hiddenRepositories.length}</span>
          )}
          {environmentName && (
            <span className="inline-flex items-center gap-1">
              <BoxIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{environmentName}</span>
            </span>
          )}
          {creator && <span>by {creator}</span>}
          <span>{SESSION_ORIGIN_LABELS[session.spawnSource]}</span>
          <time dateTime={new Date(session.updatedAt).toISOString()}>
            {formatRelativeTime(session.updatedAt)}
          </time>
          {session.parentSessionId && (
            <span className="text-accent" title={`Spawned from session ${session.parentSessionId}`}>
              Sub-task
            </span>
          )}
        </div>
      </Link>
    </li>
  );
}

interface SessionDiscoveryResultsProps {
  sessions: SessionListItem[];
  environmentNamesById: ReadonlyMap<string, string>;
  currentUserId: string | null;
  hasMore: boolean;
}

/** The result list with its live count line. */
export function SessionDiscoveryResults({
  sessions,
  environmentNamesById,
  currentUserId,
  hasMore,
}: SessionDiscoveryResultsProps) {
  return (
    <div>
      <p role="status" aria-live="polite" className="mb-2 text-xs text-muted-foreground">
        Showing {sessions.length} {sessions.length === 1 ? "session" : "sessions"}
        {hasMore ? " · More available" : ""}
      </p>
      <ul
        aria-label="Sessions"
        className="divide-y divide-border-muted rounded-md border border-border-muted"
      >
        {sessions.map((session) => (
          <SessionDiscoveryRow
            key={session.id}
            session={session}
            environmentName={
              session.environmentId ? environmentNamesById.get(session.environmentId) : undefined
            }
            currentUserId={currentUserId}
          />
        ))}
      </ul>
    </div>
  );
}
