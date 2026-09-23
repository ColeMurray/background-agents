import {
  DEFAULT_SESSION_LIST_LIMIT,
  normalizeSessionListSearch,
  SESSION_LIST_CURRENT_USER,
  type SessionListQuery,
} from "@open-inspect/shared/session-list-query";
import {
  spawnSourceSchema,
  type SessionStatus,
  type SpawnSource,
} from "@open-inspect/shared/types/sessions";
import { formatRepoLabel } from "./repo-label";

/**
 * URL state for the Sessions discovery page (`/sessions?...`).
 *
 * The page URL is the user-facing form of the shared `SessionListQuery`: the
 * same parameter names where the meaning is identical (`q`, `repoOwner`,
 * `repoName`, `environmentId`, `origin`, `createdBy=me`) plus a `lifecycle`
 * control that maps onto the API's `status`/`excludeStatus` pair. Defaults
 * are omitted so `/sessions` alone is the canonical "not archived, all
 * creators" view. Values the API would reject are reported by the parser so
 * the page can refuse them instead of widening the result set.
 */

export const SESSIONS_PATH = "/sessions";
export const SESSIONS_PAGE_SIZE = DEFAULT_SESSION_LIST_LIMIT;

export const SESSION_LIFECYCLES = ["nonarchived", "archived", "all"] as const;
export type SessionLifecycle = (typeof SESSION_LIFECYCLES)[number];
export type SessionCreatorFilter = "all" | "mine";

export interface SessionRepositoryFilter {
  repoOwner: string;
  repoName: string;
}

export interface SessionDiscoveryQuery {
  q: string;
  creator: SessionCreatorFilter;
  repository: SessionRepositoryFilter | null;
  environmentId: string | null;
  lifecycle: SessionLifecycle;
  origin: SpawnSource | null;
}

export const DEFAULT_SESSION_DISCOVERY_QUERY: SessionDiscoveryQuery = {
  q: "",
  creator: "all",
  repository: null,
  environmentId: null,
  lifecycle: "nonarchived",
  origin: null,
};

export const SESSION_LIFECYCLE_LABELS: Record<SessionLifecycle, string> = {
  nonarchived: "Not archived",
  archived: "Archived",
  all: "All",
};

/** Origin options in picker order; each is exactly one persisted `spawn_source`. */
export const SESSION_ORIGINS = spawnSourceSchema.options;

/** Origin option labels; see `SessionListQuery.origin` for the semantics. */
export const SESSION_ORIGIN_LABELS: Record<SpawnSource, string> = {
  user: "Started by a person",
  automation: "Automation run",
  agent: "Agent sub-task",
  "github-bot": "GitHub bot",
  "linear-bot": "Linear bot",
  "slack-bot": "Slack bot",
};

function isLifecycle(value: string | null): value is SessionLifecycle {
  return SESSION_LIFECYCLES.includes(value as SessionLifecycle);
}

function nonEmpty(value: string | null): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

/** Page URL parameters, named for the user-facing controls they carry. */
type SessionDiscoveryParam =
  | "q"
  | "createdBy"
  | "repoOwner"
  | "repoName"
  | "environmentId"
  | "lifecycle"
  | "origin";

export type SessionDiscoveryParseResult =
  | { success: true; data: SessionDiscoveryQuery }
  | { success: false; invalidParams: SessionDiscoveryParam[] };

/**
 * Parse the page URL with the same strictness as the API. A value the
 * server would reject (or one this page has no control for, such as a
 * creator other than `me`) is reported instead of dropped, so a bad link
 * never silently shows a wider result set than it names.
 */
export function parseSessionDiscoveryQuery(
  searchParams: URLSearchParams
): SessionDiscoveryParseResult {
  const invalidParams: SessionDiscoveryParam[] = [];

  const q = normalizeSessionListSearch(searchParams.get("q"));
  if (q === null) invalidParams.push("q");

  const createdBy = searchParams.getAll("createdBy");
  if (createdBy.some((value) => value !== SESSION_LIST_CURRENT_USER)) {
    invalidParams.push("createdBy");
  }

  const repoOwnerParam = searchParams.get("repoOwner");
  const repoNameParam = searchParams.get("repoName");
  const repoOwner = nonEmpty(repoOwnerParam);
  const repoName = nonEmpty(repoNameParam);
  if (repoOwnerParam !== null && repoOwner === null) {
    invalidParams.push("repoOwner");
  } else if (repoNameParam !== null && repoName === null) {
    invalidParams.push("repoName");
  } else if (repoOwner !== null && repoName === null) {
    invalidParams.push("repoName");
  } else if (repoOwner === null && repoName !== null) {
    invalidParams.push("repoOwner");
  }

  const environmentIdParam = searchParams.get("environmentId");
  const environmentId = nonEmpty(environmentIdParam);
  if (environmentIdParam !== null && environmentId === null) invalidParams.push("environmentId");

  const lifecycleParam = searchParams.get("lifecycle");
  if (lifecycleParam !== null && !isLifecycle(lifecycleParam)) invalidParams.push("lifecycle");

  const originParam = searchParams.get("origin");
  const origin = originParam ? spawnSourceSchema.safeParse(originParam) : null;
  if (origin && !origin.success) invalidParams.push("origin");

  if (invalidParams.length > 0) return { success: false, invalidParams };
  return {
    success: true,
    data: {
      q: q ?? "",
      creator: createdBy.length > 0 ? "mine" : "all",
      repository: repoOwner && repoName ? { repoOwner, repoName } : null,
      environmentId,
      lifecycle: isLifecycle(lifecycleParam)
        ? lifecycleParam
        : DEFAULT_SESSION_DISCOVERY_QUERY.lifecycle,
      origin: origin?.success ? origin.data : null,
    },
  };
}

export function serializeSessionDiscoveryQuery(query: SessionDiscoveryQuery): URLSearchParams {
  const searchParams = new URLSearchParams();
  const q = query.q.trim();
  if (q) searchParams.set("q", q);
  if (query.creator === "mine") searchParams.set("createdBy", SESSION_LIST_CURRENT_USER);
  if (query.repository) {
    searchParams.set("repoOwner", query.repository.repoOwner);
    searchParams.set("repoName", query.repository.repoName);
  }
  if (query.environmentId) searchParams.set("environmentId", query.environmentId);
  if (query.lifecycle !== DEFAULT_SESSION_DISCOVERY_QUERY.lifecycle) {
    searchParams.set("lifecycle", query.lifecycle);
  }
  if (query.origin) searchParams.set("origin", query.origin);
  return searchParams;
}

/** `/sessions` with only the non-default parts of `query` encoded. */
export function buildSessionsHref(query: Partial<SessionDiscoveryQuery> = {}): string {
  const searchParams = serializeSessionDiscoveryQuery({
    ...DEFAULT_SESSION_DISCOVERY_QUERY,
    ...query,
  });
  const queryString = searchParams.toString();
  return queryString ? `${SESSIONS_PATH}?${queryString}` : SESSIONS_PATH;
}

/** Whether any control differs from the default view (search text included). */
export function hasSessionDiscoveryFilters(query: SessionDiscoveryQuery): boolean {
  return serializeSessionDiscoveryQuery(query).toString() !== "";
}

/** The API query for one page of `query`, in the shared list-query contract. */
export function toSessionListQuery(
  query: SessionDiscoveryQuery,
  page: { limit: number; offset: number }
): SessionListQuery {
  const q = query.q.trim();
  return {
    limit: page.limit,
    offset: page.offset,
    ...(query.lifecycle === "archived" ? { status: "archived" as const } : {}),
    ...(query.lifecycle === "nonarchived" ? { excludeStatus: "archived" as const } : {}),
    ...(query.creator === "mine" ? { createdBy: [SESSION_LIST_CURRENT_USER] } : {}),
    ...(q ? { q } : {}),
    ...(query.repository ?? {}),
    ...(query.environmentId ? { environmentId: query.environmentId } : {}),
    ...(query.origin ? { origin: query.origin } : {}),
  };
}

/** Lifecycle status labels for result rows. */
export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  created: "Draft",
  active: "Active",
  completed: "Completed",
  failed: "Failed",
  archived: "Archived",
  cancelled: "Cancelled",
};

/**
 * Repository labels for a result row: every member of a multi-repository
 * session, or the scalar primary of a session that predates member rows.
 */
export function sessionRepositoryLabels(session: {
  repoOwner: string | null;
  repoName: string | null;
  repositories?: ReadonlyArray<{ repoOwner: string; repoName: string }>;
}): string[] {
  if (session.repositories?.length) {
    return session.repositories.map((repository) =>
      formatRepoLabel(repository.repoOwner, repository.repoName)
    );
  }
  return [formatRepoLabel(session.repoOwner, session.repoName)];
}
