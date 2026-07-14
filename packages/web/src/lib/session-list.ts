import type { Session, SidebarSessionsResponse } from "@open-inspect/shared";
import { unstable_serialize } from "swr/infinite";
import { formatRepoLabel } from "./repo-label";

export const SESSIONS_PAGE_SIZE = 50;
const COMMAND_MENU_SESSIONS_LIMIT = 100;
export const SESSIONS_API_PATH = "/api/sessions";
export const CURRENT_USER_CREATED_BY = "me";
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  view: "sidebar",
});

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

export function createSidebarSessionsKeyLoader(createdBy?: readonly string[]) {
  return (pageIndex: number, previousPage: SidebarSessionsResponse | null) => {
    if (pageIndex > 0 && !previousPage?.nextCursor) return null;
    return buildSidebarSessionsPageKey({
      createdBy,
      cursor: pageIndex > 0 ? (previousPage?.nextCursor ?? undefined) : undefined,
    });
  };
}

function sidebarSessionsRevalidationKeys(): string[] {
  return [
    unstable_serialize(createSidebarSessionsKeyLoader()),
    unstable_serialize(createSidebarSessionsKeyLoader([CURRENT_USER_CREATED_BY])),
  ];
}

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

export type SessionListRevalidationKey = string | ((key: unknown) => boolean);

export function unarchivedSessionListRevalidationKeys(): SessionListRevalidationKey[] {
  return [isUnarchivedSessionListKey, ...sidebarSessionsRevalidationKeys()];
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
