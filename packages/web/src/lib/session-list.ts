import type { Session } from "@open-inspect/shared/types/sessions";
import type { BrowserApiPath } from "./browser-api-fetch";
import { formatRepoLabel } from "./repo-label";

export const SESSIONS_PAGE_SIZE = 50;
const COMMAND_MENU_SESSIONS_LIMIT = 100;
export const SESSIONS_API_PATH = "/api/sessions";
export const CURRENT_USER_CREATED_BY = "me";
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: SESSIONS_PAGE_SIZE,
  offset: 0,
});
export const COMMAND_MENU_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: COMMAND_MENU_SESSIONS_LIMIT,
});

export interface SessionListResponse {
  sessions: Session[];
  hasMore: boolean;
}

export function buildSessionsPageKey({
  limit = SESSIONS_PAGE_SIZE,
  offset = 0,
  status,
  excludeStatus,
  excludeAutomationLineage,
  createdBy,
}: {
  limit?: number;
  offset?: number;
  status?: string;
  excludeStatus?: string;
  excludeAutomationLineage?: boolean;
  createdBy?: readonly string[];
}): BrowserApiPath {
  const searchParams = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (status) {
    searchParams.set("status", status);
  }

  if (excludeStatus) {
    searchParams.set("excludeStatus", excludeStatus);
  }

  if (excludeAutomationLineage) {
    searchParams.set("excludeAutomationLineage", "true");
  }

  for (const userId of createdBy ?? []) {
    searchParams.append("createdBy", userId);
  }

  return `${SESSIONS_API_PATH}?${searchParams.toString()}`;
}

export function isSessionListKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    (key === SESSIONS_API_PATH || key.startsWith(`${SESSIONS_API_PATH}?`))
  );
}

export function isUnarchivedSessionListKey(key: unknown): key is string {
  if (!isSessionListKey(key)) return false;

  const url = new URL(key, "http://localhost");
  return url.searchParams.get("status") !== "archived";
}

export function isArchivedSessionListKey(key: unknown): key is string {
  if (!isSessionListKey(key)) return false;

  const url = new URL(key, "http://localhost");
  return url.searchParams.get("status") === "archived";
}

// Extracted from session-sidebar so the cache-shape transformation can be unit
// tested without rendering the component or going through Radix/SWR.
export function applyTitleUpdate(
  data: SessionListResponse | undefined,
  sessionId: string,
  title: string,
  updatedAt: number
): SessionListResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((session) =>
      session.id === sessionId ? { ...session, title, updatedAt } : session
    ),
  };
}

export function applySessionReadState(
  data: SessionListResponse | undefined,
  sessionId: string,
  readState: Session["readState"]
): SessionListResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((session) => {
      if (session.id !== sessionId) return session;
      if (!readState) return session;
      const currentMessageId = session.readState?.latestMessageId;
      if (currentMessageId !== undefined && currentMessageId !== readState.latestMessageId) {
        return session;
      }
      return {
        ...session,
        readState,
      };
    }),
  };
}

export function mergeUniqueSessions(existing: Session[], incoming: Session[]) {
  const seen = new Set(existing.map((session) => session.id));
  const merged = [...existing];

  for (const session of incoming) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    merged.push(session);
  }

  return merged;
}

export function removeSessionFromList(sessions: Session[], sessionId: string) {
  return sessions.filter((session) => session.id !== sessionId);
}

export function buildSessionSearchValue(session: Session): string {
  const repositoryLabels = session.repositories?.length
    ? session.repositories.map((repository) =>
        formatRepoLabel(repository.repoOwner, repository.repoName)
      )
    : [formatRepoLabel(session.repoOwner, session.repoName)];

  return [session.id, session.title, ...repositoryLabels].filter(Boolean).join(" ");
}

/**
 * The session-detail route for a list entry, carrying the repo and title as
 * query params so the destination page can render its header before the
 * session payload loads.
 */
export function buildSessionHref(session: Session) {
  const query: Record<string, string> = {};
  if (session.repoOwner && session.repoName) {
    query.repoOwner = session.repoOwner;
    query.repoName = session.repoName;
  }
  if (session.title) {
    query.title = session.title;
  }

  return {
    pathname: `/session/${session.id}`,
    query,
  };
}
