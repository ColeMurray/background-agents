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
import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import {
  type RequestContext,
  SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
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

async function handleDashboard(request: Request, ctx: RequestContext): Promise<Response> {
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

async function handleSummary(request: Request, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getSummary(getFilters(days)));
}

async function handleTimeseries(request: Request, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(ctx.db);
  return json(await store.getTimeseries(getFilters(days)));
}

async function handleBreakdown(request: Request, ctx: RequestContext): Promise<Response> {
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

async function handlePullRequests(request: Request, ctx: RequestContext): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new PullRequestAnalyticsStore(ctx.db);
  return json(await store.get(getPullRequestFilters(days)));
}

const ANALYTICS_READ = admit({
  ...SCM_AGNOSTIC_USER_OR_SERVICE_ROUTE,
  authorization: requirePermission("analytics.read"),
});

export const analyticsRoutes = new Hono<ControlPlaneHonoEnv>();

analyticsRoutes.get("/analytics/dashboard", ANALYTICS_READ, (c) =>
  handleDashboard(c.var.admitted.request, c.var.admitted.ctx)
);
analyticsRoutes.get("/analytics/summary", ANALYTICS_READ, (c) =>
  handleSummary(c.var.admitted.request, c.var.admitted.ctx)
);
analyticsRoutes.get("/analytics/timeseries", ANALYTICS_READ, (c) =>
  handleTimeseries(c.var.admitted.request, c.var.admitted.ctx)
);
analyticsRoutes.get("/analytics/breakdown", ANALYTICS_READ, (c) =>
  handleBreakdown(c.var.admitted.request, c.var.admitted.ctx)
);
analyticsRoutes.get("/analytics/pull-requests", ANALYTICS_READ, (c) =>
  handlePullRequests(c.var.admitted.request, c.var.admitted.ctx)
);
