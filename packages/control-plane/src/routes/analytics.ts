import {
  ANALYTICS_BREAKDOWN_BY,
  ANALYTICS_DAYS,
  type AnalyticsBreakdownBy,
  type AnalyticsDays,
} from "@open-inspect/shared/types/analytics";
import { type AnalyticsFilters, AnalyticsStore, HUMAN_SPAWN_SOURCES } from "../db/analytics-store";
import { AnalyticsDashboardStore } from "../db/analytics-dashboard-store";
import {
  type PullRequestAnalyticsFilters,
  PullRequestAnalyticsStore,
} from "../db/pull-request-analytics-store";
import type { Env } from "../types";
import {
  type RequestContext,
  type Route,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  defineRoutes,
  error,
  json,
  requirePermission,
} from "./shared";

function parseDaysParam(value: string | null): AnalyticsDays | null {
  if (value === null) return 30;

  const parsed = Number(value);
  return ANALYTICS_DAYS.includes(parsed as AnalyticsDays) ? (parsed as AnalyticsDays) : null;
}

function parseBreakdownBy(value: string | null): AnalyticsBreakdownBy | null {
  if (!value) return null;
  return ANALYTICS_BREAKDOWN_BY.includes(value as AnalyticsBreakdownBy)
    ? (value as AnalyticsBreakdownBy)
    : null;
}

function getFilters(days: AnalyticsDays): AnalyticsFilters {
  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;
  return { startAt, endAt, spawnSources: HUMAN_SPAWN_SOURCES };
}

/**
 * PR analytics is scoped to the PR population itself, so unlike the session
 * analytics it applies no spawn-source filter — automation-produced PRs are
 * output too, surfaced via the source dimension instead.
 */
function getPullRequestFilters(days: AnalyticsDays): PullRequestAnalyticsFilters {
  const now = Date.now();
  return { startAt: now - days * 24 * 60 * 60 * 1000, endAt: now, now };
}

async function handleDashboard(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const generatedAt = Date.now();
  const store = new AnalyticsDashboardStore(ctx.db);
  return json(
    await store.get({
      days,
      startAt: generatedAt - days * 24 * 60 * 60 * 1000,
      endAt: generatedAt,
    })
  );
}

async function handleSummary(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getSummary(getFilters(days)));
}

async function handleTimeseries(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getTimeseries(getFilters(days)));
}

async function handleBreakdown(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const byParam = url.searchParams.get("by");
  const by = parseBreakdownBy(byParam);
  if (!by) {
    return error(`by must be one of: ${ANALYTICS_BREAKDOWN_BY.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getBreakdown(getFilters(days), by));
}

async function handlePullRequests(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new PullRequestAnalyticsStore(ctx.db);
  return json(await store.get(getPullRequestFilters(days)));
}

export const analyticsRoutes: Route[] = defineRoutes(SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE, [
  {
    method: "GET",
    path: "/analytics/dashboard",
    authorization: requirePermission("analytics.read"),
    handler: handleDashboard,
  },
  {
    method: "GET",
    path: "/analytics/summary",
    authorization: requirePermission("analytics.read"),
    handler: handleSummary,
  },
  {
    method: "GET",
    path: "/analytics/timeseries",
    authorization: requirePermission("analytics.read"),
    handler: handleTimeseries,
  },
  {
    method: "GET",
    path: "/analytics/breakdown",
    authorization: requirePermission("analytics.read"),
    handler: handleBreakdown,
  },
  {
    method: "GET",
    path: "/analytics/pull-requests",
    authorization: requirePermission("analytics.read"),
    handler: handlePullRequests,
  },
]);
