import { unarchivedSessionListRevalidationKeys } from "@/lib/session-list";
import type { ServerMessage } from "@open-inspect/shared";

/** An SWR cache key or key matcher to pass to `mutate`. */
export type SwrRevalidationKey = string | ((key: unknown) => boolean);
const SESSION_LIST_REVALIDATION_KEYS = unarchivedSessionListRevalidationKeys();

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
      return message.artifact.type === "pr" ? SESSION_LIST_REVALIDATION_KEYS : [];

    case "session_title":
      return message.title ? SESSION_LIST_REVALIDATION_KEYS : [];

    case "session_status":
      // Revalidate so the status change is reflected in the sidebar.
      return SESSION_LIST_REVALIDATION_KEYS;

    case "child_session_update":
      // Child session spawned or changed status — revalidate child list and sidebar.
      return [`/api/sessions/${sessionId}/children`, ...SESSION_LIST_REVALIDATION_KEYS];

    default:
      return [];
  }
}
