import { sessionStatusSchema, type SessionStatus } from "./types/sessions";
import { isCanonicalUserId } from "./user-id";

export const SESSION_LIST_CURRENT_USER = "me";
export const DEFAULT_SESSION_LIST_LIMIT = 50;
export const DEFAULT_SESSION_LIST_OFFSET = 0;

// Keep this in the control-plane proxy's established forwarding order.
export const SESSION_LIST_QUERY_PARAMS = [
  "status",
  "limit",
  "offset",
  "excludeStatus",
  "excludeAutomationLineage",
  "createdBy",
] as const satisfies readonly (keyof SessionListQuery)[];

export type SessionListQueryParam = (typeof SESSION_LIST_QUERY_PARAMS)[number];

export interface SessionListQuery {
  limit?: number;
  offset?: number;
  status?: SessionStatus;
  excludeStatus?: SessionStatus;
  excludeAutomationLineage?: boolean;
  createdBy?: readonly string[];
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
  return Math.min(Math.max(parsed, 1), 100);
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

  return {
    success: true,
    data: {
      limit: parsePaginationLimit(searchParams.get("limit")),
      offset: parsePaginationOffset(searchParams.get("offset")),
      status,
      excludeStatus,
      excludeAutomationLineage: excludeAutomationLineageParam === "true",
      createdBy,
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

  return searchParams;
}
