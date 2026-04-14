import {
  ANALYTICS_BREAKDOWN_BY,
  ANALYTICS_DAYS,
  type AnalyticsBreakdownBy,
  type AnalyticsDays,
} from "@open-inspect/shared";
import { AnalyticsStore } from "../db/analytics-store";
import type { Env } from "../types";
import { type RequestContext, type Route, error, json, parsePattern } from "./shared";

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

function getRange(days: AnalyticsDays): { startAt: number; endAt: number } {
  const endAt = Date.now();
  const startAt = endAt - days * 24 * 60 * 60 * 1000;
  return { startAt, endAt };
}

async function handleSummary(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(env.DB);
  return json(await store.getSummary(getRange(days)));
}

async function handleTimeseries(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const url = new URL(request.url);
  const days = parseDaysParam(url.searchParams.get("days"));
  if (!days) {
    return error(`days must be one of: ${ANALYTICS_DAYS.join(", ")}`, 400);
  }

  const store = new AnalyticsStore(env.DB);
  return json(await store.getTimeseries(getRange(days)));
}

async function handleBreakdown(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  _ctx: RequestContext
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

  const store = new AnalyticsStore(env.DB);
  return json(await store.getBreakdown(getRange(days), by));
}

export const analyticsRoutes: Route[] = [
  {
    method: "GET",
    pattern: parsePattern("/analytics/summary"),
    handler: handleSummary,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/timeseries"),
    handler: handleTimeseries,
  },
  {
    method: "GET",
    pattern: parsePattern("/analytics/breakdown"),
    handler: handleBreakdown,
  },
];
