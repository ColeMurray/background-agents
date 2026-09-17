import {
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_SESSION_LIST_OFFSET,
  serializeSessionListQuery,
  SESSION_LIST_CURRENT_USER,
  type SessionListQuery,
} from "@open-inspect/shared/session-list-query";
import {
  sessionListResponseSchema,
  sessionListSummarySchema,
  type SessionListResponse,
  type SessionListSummary,
} from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";
import { formatRepoLabel } from "./repo-label";
import { sessionReadStateClientSchema } from "./session-read-state";

const sessionListClientResponseSchema = sessionListResponseSchema.extend({
  sessions: z.array(
    sessionListSummarySchema.extend({
      readState: sessionReadStateClientSchema.optional(),
    })
  ),
});

const SESSIONS_PAGE_SIZE = DEFAULT_SESSION_LIST_LIMIT;
const COMMAND_MENU_SESSIONS_LIMIT = 100;
const SESSIONS_API_PATH = "/api/sessions";
export const CURRENT_USER_CREATED_BY = SESSION_LIST_CURRENT_USER;
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: SESSIONS_PAGE_SIZE,
  offset: 0,
});
export const COMMAND_MENU_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: COMMAND_MENU_SESSIONS_LIMIT,
});

export type SessionListItem = SessionListSummary;
export type { SessionListResponse };

export async function fetchSessionListPage(path: BrowserApiPath): Promise<SessionListResponse> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return sessionListClientResponseSchema.parse(await response.json());
}

export function buildSessionsPageKey(options: SessionListQuery = {}): BrowserApiPath {
  const searchParams = serializeSessionListQuery({
    ...options,
    limit: options.limit ?? DEFAULT_SESSION_LIST_LIMIT,
    offset: options.offset ?? DEFAULT_SESSION_LIST_OFFSET,
  });

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

export function removeSessionFromList(sessions: SessionListItem[], sessionId: string) {
  return sessions.filter((session) => session.id !== sessionId);
}

export function buildSessionSearchValue(session: SessionListItem): string {
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
export function buildSessionHref(
  session: Pick<SessionListItem, "id" | "title" | "repoOwner" | "repoName">
) {
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
