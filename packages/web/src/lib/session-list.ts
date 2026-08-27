import {
  DEFAULT_SESSION_LIST_LIMIT,
  DEFAULT_SESSION_LIST_OFFSET,
  serializeSessionListQuery,
  SESSION_LIST_CURRENT_USER,
  type SessionListQuery,
} from "@open-inspect/shared/session-list-query";
import { sessionStatusSchema, type SessionReadState } from "@open-inspect/shared/types/sessions";
import { z } from "zod";
import { browserApiFetch, type BrowserApiPath } from "./browser-api-fetch";
import { formatRepoLabel } from "./repo-label";

export const SESSIONS_PAGE_SIZE = DEFAULT_SESSION_LIST_LIMIT;
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

const sessionListItemSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  repoOwner: z.string().nullable(),
  repoName: z.string().nullable(),
  status: sessionStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  repositories: z
    .array(
      z.object({
        repoOwner: z.string(),
        repoName: z.string(),
        repoId: z.number().nullable(),
        baseBranch: z.string(),
      })
    )
    .optional(),
  readState: z
    .union([
      z.object({ latestMessageId: z.null(), unread: z.literal(false) }),
      z.object({ latestMessageId: z.string(), unread: z.boolean() }),
    ])
    .optional(),
});

export type SessionListItem = z.infer<typeof sessionListItemSchema>;

export const sessionListResponseSchema = z.object({
  sessions: z.array(sessionListItemSchema),
  hasMore: z.boolean(),
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export async function fetchSessionListPage(path: BrowserApiPath): Promise<SessionListResponse> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
  return sessionListResponseSchema.parse(await response.json());
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

// Extracted from session-sidebar so the cache-shape transformation can be unit
// tested without rendering the component or going through Radix/SWR.
export function applyTitleUpdate(
  data: SessionListResponse | undefined,
  sessionId: string,
  title: string | null
): SessionListResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    sessions: data.sessions.map((session) =>
      session.id === sessionId ? { ...session, title } : session
    ),
  };
}

export function applySessionReadState(
  data: SessionListResponse | undefined,
  sessionId: string,
  readState: SessionReadState | undefined
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
