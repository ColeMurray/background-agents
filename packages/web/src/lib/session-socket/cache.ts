import { isUnarchivedSessionListKey } from "@/lib/session-list";
import type { ServerMessage } from "@open-inspect/shared";

/** An SWR cache key or key matcher to pass to `mutate`. */
export type SessionCacheKey = string | ((key: unknown) => boolean);

/**
 * SWR cache keys to revalidate in response to a server message. This is the
 * whole cache side-effect surface of the session socket — the hook maps each
 * key through `mutate`; everything here stays pure and testable.
 *
 * Only PR artifacts revalidate the session list — they feed the sidebar's PR
 * summary; media artifacts (screenshots, video) arrive at high frequency
 * during a run and cannot change the list.
 */
export function cacheKeysToRevalidate(
  message: ServerMessage,
  sessionId: string
): SessionCacheKey[] {
  switch (message.type) {
    case "artifact_created":
    case "artifact_updated":
      return message.artifact.type === "pr" ? [isUnarchivedSessionListKey] : [];

    case "session_title":
      return message.title ? [isUnarchivedSessionListKey] : [];

    case "session_status":
      // Revalidate so the status change is reflected in the sidebar.
      return [isUnarchivedSessionListKey];

    case "child_session_update":
      // Child session spawned or changed status — revalidate child list and sidebar.
      return [`/api/sessions/${sessionId}/children`, isUnarchivedSessionListKey];

    default:
      return [];
  }
}
