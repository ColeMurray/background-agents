import { isUnarchivedSessionListKey } from "@/lib/session-list";
import type { ServerMessage } from "@open-inspect/shared";

/** An SWR cache key or key matcher to pass to `mutate`. */
export type SwrRevalidationKey = string | ((key: unknown) => boolean);

/**
 * Which SWR caches a server message invalidates. Session-socket messages can
 * change data that other views render — the sidebar session list and a
 * session's child list — and this decides, per message, which of those must
 * refetch. `useSessionSocket` maps each key through `mutate`; everything here
 * stays pure and testable.
 *
 * Only PR artifacts revalidate the session list — they feed the sidebar's PR
 * summary; media artifacts (screenshots, video) arrive at high frequency
 * during a run and cannot change the list.
 */
export function swrKeysToRevalidate(
  message: ServerMessage,
  sessionId: string
): SwrRevalidationKey[] {
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
