import {
  ANALYTICS_BREAKDOWN_BY,
  ANALYTICS_DAYS,
  type AnalyticsDays,
} from "@open-inspect/shared/types/analytics";
import { type AnalyticsFilters, AnalyticsStore, HUMAN_SPAWN_SOURCES } from "../db/analytics-store";
import { AnalyticsDashboardStore } from "../db/analytics-dashboard-store";
import {
  type PullRequestAnalyticsFilters,
  PullRequestAnalyticsStore,
} from "../db/pull-request-analytics-store";
import { Hono } from "hono";
import { z } from "zod";
import { admit, dispatch } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import type { Env } from "../types";
import { parseQuery } from "./query";
import {
  type RequestContext,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  json,
  requirePermission,
} from "./shared";

export const DEFAULT_ANALYTICS_DAYS: AnalyticsDays = 30;

/** The reporting window; absent, the default. The value is read the way `Number()` reads it. */
const daysQuery = z.object({
  days: z
    .string()
    .optional()
    .transform((raw) => (raw === undefined ? DEFAULT_ANALYTICS_DAYS : Number(raw)))
    .pipe(
      z.literal(ANALYTICS_DAYS, { error: `days must be one of: ${ANALYTICS_DAYS.join(", ")}` })
    ),
});

const breakdownQuery = daysQuery.extend({
  by: z.enum(ANALYTICS_BREAKDOWN_BY, {
    error: `by must be one of: ${ANALYTICS_BREAKDOWN_BY.join(", ")}`,
  }),
});

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
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, daysQuery);
  if (query instanceof Response) return query;
  const { days } = query;

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
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, daysQuery);
  if (query instanceof Response) return query;
  const { days } = query;

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getSummary(getFilters(days)));
}

async function handleTimeseries(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, daysQuery);
  if (query instanceof Response) return query;
  const { days } = query;

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getTimeseries(getFilters(days)));
}

async function handleBreakdown(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, breakdownQuery);
  if (query instanceof Response) return query;
  const { days, by } = query;

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getBreakdown(getFilters(days), by));
}

async function handlePullRequests(
  request: Request,
  _env: Env,
  _params: object,
  ctx: RequestContext
): Promise<Response> {
  const query = parseQuery(request, daysQuery);
  if (query instanceof Response) return query;
  const { days } = query;

  const store = new PullRequestAnalyticsStore(ctx.db);
  return json(await store.get(getPullRequestFilters(days)));
}

const ANALYTICS_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("analytics.read"),
});

export const analyticsRoutes = new Hono<ControlPlaneHonoEnv>();

analyticsRoutes.get("/analytics/dashboard", ANALYTICS_READ, (c) => dispatch(c, handleDashboard));
analyticsRoutes.get("/analytics/summary", ANALYTICS_READ, (c) => dispatch(c, handleSummary));
analyticsRoutes.get("/analytics/timeseries", ANALYTICS_READ, (c) => dispatch(c, handleTimeseries));
analyticsRoutes.get("/analytics/breakdown", ANALYTICS_READ, (c) => dispatch(c, handleBreakdown));
analyticsRoutes.get("/analytics/pull-requests", ANALYTICS_READ, (c) =>
  dispatch(c, handlePullRequests)
);
