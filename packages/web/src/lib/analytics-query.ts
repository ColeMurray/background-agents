import { buildControlPlanePath } from "./control-plane-query";

export function buildAnalyticsSummaryPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/summary", searchParams, ["days"]);
}

export function buildAnalyticsTimeseriesPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/timeseries", searchParams, ["days"]);
}

export function buildAnalyticsBreakdownPath(searchParams: URLSearchParams): string {
  return buildControlPlanePath("/analytics/breakdown", searchParams, ["days", "by"]);
}
