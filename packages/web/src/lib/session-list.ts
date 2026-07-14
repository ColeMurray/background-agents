import type { Session, SidebarSessionsResponse } from "@open-inspect/shared";
import { formatRepoLabel } from "./repo-label";

export const SESSIONS_PAGE_SIZE = 50;
const COMMAND_MENU_SESSIONS_LIMIT = 100;
export const SESSIONS_API_PATH = "/api/sessions";
export const CURRENT_USER_CREATED_BY = "me";
const SWR_INFINITE_PREFIX = "$inf$";
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  view: "sidebar",
});
export const SIDEBAR_MINE_SESSIONS_KEY = buildSessionsPageKey({
  view: "sidebar",
  createdBy: [CURRENT_USER_CREATED_BY],
});
export const SIDEBAR_INFINITE_KEYS = [
  `${SWR_INFINITE_PREFIX}${SIDEBAR_SESSIONS_KEY}`,
  `${SWR_INFINITE_PREFIX}${SIDEBAR_MINE_SESSIONS_KEY}`,
] as const;

export function buildSidebarSessionsPageKey({
  createdBy,
  cursor,
}: {
  createdBy?: readonly string[];
  cursor?: string;
} = {}) {
  return buildSessionsPageKey({ view: "sidebar", createdBy, cursor });
}
export const COMMAND_MENU_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: COMMAND_MENU_SESSIONS_LIMIT,
});

export interface SessionListResponse {
  sessions: Session[];
  hasMore: boolean;
}

export type SidebarSessionListResponse = SidebarSessionsResponse;

export function buildSessionsPageKey({
  limit = SESSIONS_PAGE_SIZE,
  offset = 0,
  status,
  excludeStatus,
  createdBy,
  view,
  cursor,
}: {
  limit?: number;
  offset?: number;
  status?: string;
  excludeStatus?: string;
  createdBy?: readonly string[];
  view?: "sidebar";
  cursor?: string;
}) {
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

  if (view) {
    searchParams.set("view", view);
  }

  if (cursor) {
    searchParams.set("cursor", cursor);
  }

  for (const userId of createdBy ?? []) {
    searchParams.append("createdBy", userId);
  }

  return `${SESSIONS_API_PATH}?${searchParams.toString()}`;
}

export function isSessionListKey(key: unknown): key is string {
  const normalizedKey =
    typeof key === "string" && key.startsWith(SWR_INFINITE_PREFIX)
      ? key.slice(SWR_INFINITE_PREFIX.length)
      : key;
  return (
    typeof normalizedKey === "string" &&
    (normalizedKey === SESSIONS_API_PATH || normalizedKey.startsWith(`${SESSIONS_API_PATH}?`))
  );
}

function normalizeSessionListKey(key: string): string {
  return key.startsWith(SWR_INFINITE_PREFIX) ? key.slice(SWR_INFINITE_PREFIX.length) : key;
}

export function isUnarchivedSessionListKey(key: unknown): key is string {
  if (!isSessionListKey(key)) return false;

  const url = new URL(normalizeSessionListKey(key), "http://localhost");
  return url.searchParams.get("status") !== "archived";
}

export function isArchivedSessionListKey(key: unknown): key is string {
  if (!isSessionListKey(key)) return false;

  const url = new URL(normalizeSessionListKey(key), "http://localhost");
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

export function applySidebarTitleUpdate(
  data: SidebarSessionsResponse[] | undefined,
  sessionId: string,
  title: string,
  updatedAt: number
): SidebarSessionsResponse[] | undefined {
  return data?.map((page) => ({
    ...page,
    trees: page.trees.map((tree) => ({
      ...tree,
      activityAt: tree.sessions.some((session) => session.id === sessionId)
        ? Math.max(tree.activityAt, updatedAt)
        : tree.activityAt,
      sessions: tree.sessions.map((session) =>
        session.id === sessionId ? { ...session, title, updatedAt } : session
      ),
    })),
  }));
}

export function removeSessionFromSidebar(
  data: SidebarSessionsResponse[] | undefined,
  sessionId: string
): SidebarSessionsResponse[] | undefined {
  return data?.map((page) => ({
    ...page,
    trees: page.trees
      .map((tree) => ({
        ...tree,
        sessions: tree.sessions.filter((session) => session.id !== sessionId),
      }))
      .filter((tree) => tree.sessions.length > 0),
  }));
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
