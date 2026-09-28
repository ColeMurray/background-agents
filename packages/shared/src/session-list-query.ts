import {
  sessionStatusSchema,
  spawnSourceSchema,
  type SessionStatus,
  type SpawnSource,
} from "./types/sessions";
import { isCanonicalUserId } from "./user-id";

export const SESSION_LIST_CURRENT_USER = "me";
export const DEFAULT_SESSION_LIST_LIMIT = 50;
export const DEFAULT_SESSION_LIST_OFFSET = 0;
export const MAX_SESSION_LIST_LIMIT = 100;
/** Longest accepted `q` after trimming; longer input is rejected, not truncated. */
export const MAX_SESSION_LIST_SEARCH_LENGTH = 200;
/** Longest accepted repository owner/name or environment id filter value. */
const MAX_SESSION_LIST_IDENTIFIER_LENGTH = 256;

// Keep this in the control-plane proxy's established forwarding order.
export const SESSION_LIST_QUERY_PARAMS = [
  "status",
  "limit",
  "offset",
  "excludeStatus",
  "excludeAutomationLineage",
  "createdBy",
  "q",
  "repoOwner",
  "repoName",
  "environmentId",
  "origin",
] as const satisfies readonly (keyof SessionListQuery)[];

export type SessionListQueryParam = (typeof SESSION_LIST_QUERY_PARAMS)[number];

export interface SessionListQuery {
  limit?: number;
  offset?: number;
  status?: SessionStatus;
  excludeStatus?: SessionStatus;
  excludeAutomationLineage?: boolean;
  createdBy?: readonly string[];
  /**
   * Bounded discovery search. Matches a session when the trimmed text is a
   * case-insensitive substring of its title, a prefix of its id, or a
   * substring of any member repository's `owner/name` (including the scalar
   * primary of sessions that predate `session_repositories`).
   */
  q?: string;
  /** Repository filter; `repoOwner` and `repoName` are only valid together. */
  repoOwner?: string;
  repoName?: string;
  /** Sessions launched from this environment (`sessions.environment_id`). */
  environmentId?: string;
  /**
   * Automation-origin filter over the persisted `spawn_source` provenance:
   * `user` was started by a person in the app, `automation` is an automation
   * run's root session, `agent` was spawned by another session, and the bot
   * values were opened through that integration. It is neither "not mine"
   * nor "everything an automation touched" — an agent child of an automation
   * run is `agent`.
   */
  origin?: SpawnSource;
}

type SessionListQueryParamsAreExhaustive =
  Exclude<keyof SessionListQuery, SessionListQueryParam> extends never ? true : never;
const _sessionListQueryParamsAreExhaustive: SessionListQueryParamsAreExhaustive = true;
void _sessionListQueryParamsAreExhaustive;

export type ParsedSessionListQuery = SessionListQuery & {
  limit: number;
  offset: number;
  excludeAutomationLineage: boolean;
  createdBy: string[];
};

export type SessionListQueryParseResult =
  | { success: true; data: ParsedSessionListQuery }
  | { success: false; invalidParam: SessionListQueryParam };

function parsePaginationLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? String(DEFAULT_SESSION_LIST_LIMIT), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_LIST_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_SESSION_LIST_LIMIT);
}

function parsePaginationOffset(value: string | null): number {
  const parsed = Number.parseInt(value ?? String(DEFAULT_SESSION_LIST_OFFSET), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_LIST_OFFSET;
  return Math.max(parsed, 0);
}

function parseStatus(value: string | null): SessionStatus | undefined {
  if (!value) return undefined;
  const parsed = sessionStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The search text as the server matches it: trimmed, with an empty result
 * meaning "no search". Returns null when the text exceeds the accepted length.
 */
export function normalizeSessionListSearch(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > MAX_SESSION_LIST_SEARCH_LENGTH) return null;
  return trimmed;
}

function parseIdentifier(value: string | null): string | null | undefined {
  if (value === null || value === "") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_SESSION_LIST_IDENTIFIER_LENGTH) return null;
  return trimmed;
}

export function parseSessionListQuery(searchParams: URLSearchParams): SessionListQueryParseResult {
  const statusParam = searchParams.get("status");
  const excludeStatusParam = searchParams.get("excludeStatus");
  const excludeAutomationLineageParam = searchParams.get("excludeAutomationLineage");
  const status = parseStatus(statusParam);
  const excludeStatus = parseStatus(excludeStatusParam);

  if (statusParam && !status) return { success: false, invalidParam: "status" };
  if (excludeStatusParam && !excludeStatus) {
    return { success: false, invalidParam: "excludeStatus" };
  }
  if (
    excludeAutomationLineageParam !== null &&
    excludeAutomationLineageParam !== "true" &&
    excludeAutomationLineageParam !== "false"
  ) {
    return { success: false, invalidParam: "excludeAutomationLineage" };
  }

  const createdBy = searchParams.getAll("createdBy");
  if (createdBy.some((value) => value !== SESSION_LIST_CURRENT_USER && !isCanonicalUserId(value))) {
    return { success: false, invalidParam: "createdBy" };
  }

  const q = normalizeSessionListSearch(searchParams.get("q"));
  if (q === null) return { success: false, invalidParam: "q" };

  const repoOwner = parseIdentifier(searchParams.get("repoOwner"));
  if (repoOwner === null) return { success: false, invalidParam: "repoOwner" };
  const repoName = parseIdentifier(searchParams.get("repoName"));
  if (repoName === null) return { success: false, invalidParam: "repoName" };
  if ((repoOwner === undefined) !== (repoName === undefined)) {
    return { success: false, invalidParam: repoOwner === undefined ? "repoOwner" : "repoName" };
  }

  const environmentId = parseIdentifier(searchParams.get("environmentId"));
  if (environmentId === null) return { success: false, invalidParam: "environmentId" };

  const originParam = searchParams.get("origin");
  const origin = originParam ? spawnSourceSchema.safeParse(originParam) : undefined;
  if (origin && !origin.success) return { success: false, invalidParam: "origin" };

  return {
    success: true,
    data: {
      limit: parsePaginationLimit(searchParams.get("limit")),
      offset: parsePaginationOffset(searchParams.get("offset")),
      status,
      excludeStatus,
      excludeAutomationLineage: excludeAutomationLineageParam === "true",
      createdBy,
      ...(q ? { q } : {}),
      ...(repoOwner !== undefined && repoName !== undefined ? { repoOwner, repoName } : {}),
      ...(environmentId !== undefined ? { environmentId } : {}),
      ...(origin ? { origin: origin.data } : {}),
    },
  };
}

export function serializeSessionListQuery(query: SessionListQuery): URLSearchParams {
  const searchParams = new URLSearchParams();

  if (query.limit !== undefined) searchParams.set("limit", String(query.limit));
  if (query.offset !== undefined) searchParams.set("offset", String(query.offset));
  if (query.status) searchParams.set("status", query.status);
  if (query.excludeStatus) searchParams.set("excludeStatus", query.excludeStatus);
  if (query.excludeAutomationLineage) {
    searchParams.set("excludeAutomationLineage", "true");
  }
  for (const value of query.createdBy ?? []) searchParams.append("createdBy", value);
  const q = query.q?.trim();
  if (q) searchParams.set("q", q);
  if (query.repoOwner && query.repoName) {
    searchParams.set("repoOwner", query.repoOwner);
    searchParams.set("repoName", query.repoName);
  }
  if (query.environmentId) searchParams.set("environmentId", query.environmentId);
  if (query.origin) searchParams.set("origin", query.origin);

  return searchParams;
}
