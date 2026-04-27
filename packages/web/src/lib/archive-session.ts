import { mutate } from "swr";
import {
  removeSessionFromList,
  SIDEBAR_SESSIONS_KEY,
  type SessionListResponse,
} from "@/lib/session-list";

export async function requestArchiveSession(sessionId: string) {
  const response = await fetch(`/api/sessions/${sessionId}/archive`, { method: "POST" });
  if (!response.ok) {
    console.error("Failed to archive session");
    return false;
  }

  return true;
}

export async function removeSessionFromSidebarCache(sessionId: string) {
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
