import {
  DEFAULT_SESSION_LIST_LIMIT,
  parseSessionListQuery,
  SESSION_LIST_CURRENT_USER,
  type SessionListQuery,
  type SessionListQueryParam,
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

/** Page parameters carried unchanged to the shared list-query codec. */
const SESSION_DISCOVERY_TRANSPORT_PARAMS = [
  "q",
  "createdBy",
  "repoOwner",
  "repoName",
  "environmentId",
  "origin",
] as const satisfies readonly SessionListQueryParam[];

/** Every parameter a `/sessions` URL may carry; anything else is refused. */
const SESSION_DISCOVERY_PARAMS: readonly string[] = [
  ...SESSION_DISCOVERY_TRANSPORT_PARAMS,
  "lifecycle",
];

export type SessionDiscoveryParseResult =
  | { success: true; data: SessionDiscoveryQuery }
  | { success: false; invalidParams: string[] };

/**
 * Parse the page URL. The shared list-query codec is the validation boundary
 * for every transport parameter, so a value the API would reject is refused
 * here first. The page adds its own rules: `createdBy` may only be `me` (the
 * page has no control for other creators), `lifecycle` is the page's own
 * control, no parameter repeats, and any other parameter is unsupported —
 * including API parameters the page has no control for, such as `status`.
 * Refusing is deliberate: a bad link must never silently show a wider or
 * different result set than it names.
 */
export function parseSessionDiscoveryQuery(
  searchParams: URLSearchParams
): SessionDiscoveryParseResult {
  const invalidParams = new Set<string>();
  for (const key of new Set(searchParams.keys())) {
    if (!SESSION_DISCOVERY_PARAMS.includes(key) || searchParams.getAll(key).length > 1) {
      invalidParams.add(key);
    }
  }

  const transport = new URLSearchParams();
  for (const key of SESSION_DISCOVERY_TRANSPORT_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null) transport.set(key, value);
  }
  const parsed = parseSessionListQuery(transport);
  if (!parsed.success) {
    invalidParams.add(parsed.invalidParam);
  } else if (parsed.data.createdBy.some((value) => value !== SESSION_LIST_CURRENT_USER)) {
    invalidParams.add("createdBy");
  }

  const lifecycleParam = searchParams.get("lifecycle");
  if (lifecycleParam !== null && !isLifecycle(lifecycleParam)) invalidParams.add("lifecycle");

  if (!parsed.success || invalidParams.size > 0) {
    return { success: false, invalidParams: [...invalidParams] };
  }
  const { q, createdBy, repoOwner, repoName, environmentId, origin } = parsed.data;
  return {
    success: true,
    data: {
      q: q ?? "",
      creator: createdBy.length > 0 ? "mine" : "all",
      repository: repoOwner && repoName ? { repoOwner, repoName } : null,
      environmentId: environmentId ?? null,
      lifecycle: isLifecycle(lifecycleParam)
        ? lifecycleParam
        : DEFAULT_SESSION_DISCOVERY_QUERY.lifecycle,
      origin: origin ?? null,
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
