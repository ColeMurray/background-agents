// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { ANALYTICS_REFRESH_INTERVAL_MS } from "@/lib/analytics";
import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import { useAnalyticsDashboard } from "./use-analytics";

vi.mock("swr", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));

const snapshot = {
  generatedAt: 1_700_000_000_000,
  window: {
    days: 30 as const,
    scope: "human" as const,
    startAt: 1_697_408_000_000,
    endAt: 1_700_000_000_000,
  },
  summary: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRatio: null,
    totalSessions: 1,
    activeUsers: 1,
    totalCost: 1,
    privateSessionsCostUsd: 0,
    avgCost: 1,
    totalPrs: 9,
    statusBreakdown: {
      created: 0,
      active: 0,
      completed: 1,
      failed: 0,
      archived: 0,
      cancelled: 0,
    },
  },
  timeseries: { series: [] },
  sessionOrigins: [{ source: "slack-bot", userKey: "alice", displayName: "Alice", sessions: 1 }],
  breakdowns: {
    repository: { entries: [] },
    user: { entries: [] },
    model: { entries: [] },
    harness: { entries: [] },
    provider: { entries: [] },
    automation: { entries: [] },
  },
  pullRequests: {
    funnel: { created: 2, open: 1, draft: 0, merged: 1, closed: 0 },
    prSessionCost: 1,
    mergedInWindow: 1,
    avgTimeToMergeMs: 100,
    openInventory: { total: 1, avgAgeMs: 200 },
    timeseries: [],
    repos: [],
    sources: [],
    models: [],
    harnesses: [],
  },
  runs: [],
} satisfies AnalyticsDashboardResponse;

describe("useAnalyticsDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuthSession).mockReturnValue({ data: { user: {} } } as never);
  });

  it("uses one SWR resource per range and scope and retains a complete cached snapshot on failure", () => {
    const error = new Error("refresh failed");
    vi.mocked(useSWR).mockReturnValue({
      data: snapshot,
      error,
      isLoading: false,
      isValidating: false,
    } as never);

    const { result } = renderHook(() => useAnalyticsDashboard(30, "human"));

    expect(useSWR).toHaveBeenCalledTimes(1);
    expect(useSWR).toHaveBeenCalledWith("/api/analytics/dashboard?days=30&scope=human", {
      refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS,
      keepPreviousData: true,
    });
    expect(result.current).toEqual({
      dashboard: snapshot,
      loading: false,
      stale: false,
      validating: false,
      error,
    });
  });

  it("marks the previous range's snapshot as stale while the requested one loads", () => {
    vi.mocked(useSWR).mockReturnValue({ data: snapshot, isLoading: true } as never);

    expect(renderHook(() => useAnalyticsDashboard(7, "human")).result.current).toMatchObject({
      dashboard: snapshot,
      loading: false,
      stale: true,
    });
    expect(renderHook(() => useAnalyticsDashboard(30, "agent")).result.current.stale).toBe(true);
  });

  it("keeps a failed range change's previous snapshot stale but not in flight", () => {
    const error = new Error("range failed");
    vi.mocked(useSWR).mockReturnValue({
      data: snapshot,
      error,
      isLoading: false,
      isValidating: false,
    } as never);

    expect(renderHook(() => useAnalyticsDashboard(7, "human")).result.current).toMatchObject({
      dashboard: snapshot,
      stale: true,
      validating: false,
      error,
    });
  });

  it("reports loading only while there is nothing to show", () => {
    vi.mocked(useSWR).mockReturnValue({ data: undefined, isLoading: true } as never);

    expect(renderHook(() => useAnalyticsDashboard(30, "human")).result.current).toMatchObject({
      dashboard: undefined,
      loading: true,
      stale: false,
    });
  });

  it("does not request analytics before authentication completes", () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null } as never);
    vi.mocked(useSWR).mockReturnValue({ data: undefined, isLoading: false } as never);

    renderHook(() => useAnalyticsDashboard(7, "human"));

    expect(useSWR).toHaveBeenCalledWith(null, {
      refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS,
      keepPreviousData: true,
    });
  });
});
