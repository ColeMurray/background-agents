// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type {
  AnalyticsBreakdownResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared";
import AnalyticsPage from "./page";

expect.extend(matchers);

const { mockUseAnalyticsDashboard, mockUseSidebarContext } = vi.hoisted(() => ({
  mockUseAnalyticsDashboard: vi.fn(),
  mockUseSidebarContext: vi.fn(),
}));

vi.mock("@/hooks/use-analytics", () => ({
  useAnalyticsDashboard: mockUseAnalyticsDashboard,
}));

vi.mock("@/components/sidebar-layout", () => ({
  useSidebarContext: mockUseSidebarContext,
}));

vi.mock("@/components/analytics/summary-cards", () => ({
  AnalyticsSummaryCards: () => <div data-testid="analytics-summary-cards" />,
}));

vi.mock("@/components/analytics/timeseries-chart", () => ({
  AnalyticsTimeseriesChart: () => <div data-testid="analytics-timeseries-chart" />,
}));

vi.mock("@/components/analytics/repo-bar-chart", () => ({
  AnalyticsRepoBarChart: () => <div data-testid="analytics-repo-chart" />,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const summary: AnalyticsSummaryResponse = {
  totalSessions: 13,
  activeUsers: 3,
  totalCost: 12.5,
  avgCost: 0.96,
  totalPrs: 4,
  statusBreakdown: {
    created: 0,
    active: 1,
    completed: 10,
    failed: 1,
    archived: 0,
    cancelled: 1,
  },
};

const timeseries: AnalyticsTimeseriesResponse = {
  series: [
    {
      date: "2026-04-10",
      groups: {
        zoe: 2,
        anna: 1,
      },
    },
  ],
};

const repoBreakdown: AnalyticsBreakdownResponse = {
  entries: [
    {
      key: "open-inspect/background-agents",
      sessions: 8,
      completed: 7,
      failed: 1,
      cancelled: 0,
      cost: 8.25,
      prs: 3,
      messageCount: 42,
      avgDuration: 120000,
      lastActive: Date.UTC(2026, 3, 12),
    },
  ],
};

const userBreakdown: AnalyticsBreakdownResponse = {
  entries: [
    {
      key: "zoe",
      sessions: 8,
      completed: 7,
      failed: 1,
      cancelled: 0,
      cost: 8.25,
      prs: 3,
      messageCount: 42,
      avgDuration: 120000,
      lastActive: Date.UTC(2026, 3, 12),
    },
    {
      key: "anna",
      sessions: 3,
      completed: 2,
      failed: 0,
      cancelled: 1,
      cost: 2.1,
      prs: 1,
      messageCount: 14,
      avgDuration: 60000,
      lastActive: Date.UTC(2026, 3, 10),
    },
    {
      key: "mike",
      sessions: 1,
      completed: 1,
      failed: 0,
      cancelled: 0,
      cost: 0.4,
      prs: 0,
      messageCount: 3,
      avgDuration: 15000,
      lastActive: Date.UTC(2026, 3, 9),
    },
  ],
};

function renderPage() {
  mockUseSidebarContext.mockReturnValue({
    isOpen: true,
    toggle: vi.fn(),
  });

  mockUseAnalyticsDashboard.mockImplementation(() => ({
    summary,
    timeseries,
    repoBreakdown,
    userBreakdown,
    loading: false,
    error: undefined,
  }));

  return render(<AnalyticsPage />);
}

function getUserRows() {
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  return rows.slice(1);
}

describe("AnalyticsPage", () => {
  it("refetches analytics when the selected range changes", async () => {
    const user = userEvent.setup();

    renderPage();

    expect(mockUseAnalyticsDashboard).toHaveBeenCalledWith(30);

    await user.click(screen.getByRole("radio", { name: "7d" }));

    await waitFor(() => {
      expect(mockUseAnalyticsDashboard).toHaveBeenLastCalledWith(7);
    });
  });

  it("re-sorts the per-user table when a header is clicked", async () => {
    const user = userEvent.setup();

    renderPage();

    let rows = getUserRows();
    expect(within(rows[0]).getByText("zoe")).toBeInTheDocument();
    expect(within(rows[1]).getByText("anna")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /user/i }));

    rows = getUserRows();
    expect(within(rows[0]).getByText("anna")).toBeInTheDocument();
    expect(within(rows[1]).getByText("mike")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /user/i }));

    rows = getUserRows();
    expect(within(rows[0]).getByText("zoe")).toBeInTheDocument();
    expect(within(rows[1]).getByText("mike")).toBeInTheDocument();
  });

  it("shows the alert without rendering widgets when loading fails with no cached data", () => {
    mockUseSidebarContext.mockReturnValue({
      isOpen: true,
      toggle: vi.fn(),
    });

    mockUseAnalyticsDashboard.mockImplementation(() => ({
      summary: undefined,
      timeseries: undefined,
      repoBreakdown: undefined,
      userBreakdown: undefined,
      loading: false,
      error: new Error("request failed"),
    }));

    render(<AnalyticsPage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByTestId("analytics-summary-cards")).not.toBeInTheDocument();
    expect(screen.queryByTestId("analytics-timeseries-chart")).not.toBeInTheDocument();
    expect(screen.queryByTestId("analytics-repo-chart")).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
