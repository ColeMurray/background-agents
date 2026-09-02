// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { ANALYTICS_REFRESH_INTERVAL_MS } from "@/lib/analytics";
import { useAnalyticsDashboard } from "./use-analytics";

vi.mock("swr", () => ({ default: vi.fn() }));
vi.mock("@/lib/auth-session", () => ({ useAuthSession: vi.fn() }));

const snapshot = {
  generatedAt: 1_700_000_000_000,
  window: { days: 30 as const, startAt: 1_697_408_000_000, endAt: 1_700_000_000_000 },
  summary: {
    totalSessions: 1,
    activeUsers: 1,
    totalCost: 1,
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
  breakdowns: { repository: { entries: [] }, user: { entries: [] } },
  pullRequests: {
    funnel: { created: 2, open: 1, draft: 0, merged: 1, closed: 0 },
    prSessionCost: 1,
    mergedInWindow: 1,
    avgTimeToMergeMs: 100,
    openInventory: { total: 1, avgAgeMs: 200 },
    timeseries: [],
    repos: [],
    sources: [],
  },
};

describe("useAnalyticsDashboard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAuthSession).mockReturnValue({ data: { user: {} } } as never);
  });

  it("uses one SWR resource per range and retains a complete cached snapshot on failure", () => {
    const error = new Error("refresh failed");
    vi.mocked(useSWR).mockReturnValue({ data: snapshot, error, isLoading: false } as never);

    const { result } = renderHook(() => useAnalyticsDashboard(30));

    expect(useSWR).toHaveBeenCalledTimes(1);
    expect(useSWR).toHaveBeenCalledWith("/api/analytics/dashboard?days=30", {
      refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS,
    });
    expect(result.current).toMatchObject({
      summary: snapshot.summary,
      timeseries: snapshot.timeseries,
      repoBreakdown: snapshot.breakdowns.repository,
      userBreakdown: snapshot.breakdowns.user,
      pullRequests: snapshot.pullRequests,
      loading: false,
      error,
    });
  });

  it("does not request analytics before authentication completes", () => {
    vi.mocked(useAuthSession).mockReturnValue({ data: null } as never);
    vi.mocked(useSWR).mockReturnValue({ data: undefined, isLoading: false } as never);

    renderHook(() => useAnalyticsDashboard(7));

    expect(useSWR).toHaveBeenCalledWith(null, {
      refreshInterval: ANALYTICS_REFRESH_INTERVAL_MS,
    });
  });
});
