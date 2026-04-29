import { mutate } from "swr";
import { toast } from "sonner";
import {
  removeSessionFromList,
  SIDEBAR_SESSIONS_KEY,
  type SessionListResponse,
} from "@/lib/session-list";

/**
 * Removes an archived session from the cached sidebar list without triggering revalidation.
 */
async function removeSessionFromSidebarCache(sessionId: string) {
  await mutate<SessionListResponse>(
    SIDEBAR_SESSIONS_KEY,
    (currentData?: SessionListResponse) =>
      currentData
        ? {
            ...currentData,
            sessions: removeSessionFromList(currentData.sessions, sessionId),
          }
        : currentData,
    {
      revalidate: false,
      populateCache: true,
    }
  );
}

/**
 * Archives a session and updates the sidebar cache so archived sessions disappear immediately.
 *
 * Returns `true` only when both the archive request and cache update succeed.
 */
export async function archiveSession(sessionId: string): Promise<boolean> {
  try {
    const response = await fetch(`/api/sessions/${sessionId}/archive`, { method: "POST" });
    if (!response.ok) {
      toast.error("Failed to archive session");
      return false;
    }

    await removeSessionFromSidebarCache(sessionId);
    return true;
  } catch {
    toast.error("Failed to archive session");
    return false;
  }
}
