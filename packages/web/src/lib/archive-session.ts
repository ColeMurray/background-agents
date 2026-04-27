import { mutate } from "swr";
import {
  removeSessionFromList,
  SIDEBAR_SESSIONS_KEY,
  type SessionListResponse,
} from "@/lib/session-list";

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

export async function archiveSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/archive`, { method: "POST" });
  if (!response.ok) {
    console.error("Failed to archive session");
    return false;
  }

  await removeSessionFromSidebarCache(sessionId);
  return true;
}
