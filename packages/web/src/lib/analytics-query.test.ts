import { describe, expect, it } from "vitest";
import {
  buildAnalyticsBreakdownPath,
  buildAnalyticsSummaryPath,
  buildAnalyticsTimeseriesPath,
} from "./analytics-query";

describe("analytics query helpers", () => {
  it("forwards only days for summary", () => {
    const searchParams = new URLSearchParams("days=14&debug=true");

    expect(buildAnalyticsSummaryPath(searchParams)).toBe("/analytics/summary?days=14");
  });

  it("forwards only days for timeseries", () => {
    const searchParams = new URLSearchParams("view=status&trace=1&days=30");

    expect(buildAnalyticsTimeseriesPath(searchParams)).toBe("/analytics/timeseries?days=30");
  });

  it("forwards days and by for breakdown in canonical order", () => {
    const searchParams = new URLSearchParams("by=repo&days=90&extra=true");

    expect(buildAnalyticsBreakdownPath(searchParams)).toBe("/analytics/breakdown?days=90&by=repo");
  });
});
