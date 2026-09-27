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
} from "@open-inspect/shared/types/analytics";
import AnalyticsPage from "./page";

expect.extend(matchers);

const zeroTokens = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

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

vi.mock("@/components/analytics/token-cards", () => ({
  AnalyticsTokenCards: () => <div data-testid="analytics-token-cards" />,
}));

vi.mock("@/components/analytics/model-bar-chart", () => ({
  AnalyticsModelBarChart: ({ entries }: { entries?: AnalyticsBreakdownResponse["entries"] }) => (
    <div data-testid="analytics-model-chart" data-entries={JSON.stringify(entries)} />
  ),
}));

vi.mock("@/components/analytics/dimension-table", () => ({
  AnalyticsDimensionTable: ({
    title,
    entries,
  }: {
    title: string;
    entries?: AnalyticsBreakdownResponse["entries"];
  }) => (
    <div
      data-testid={
        title === "Providers" ? "analytics-provider-table" : "analytics-automation-table"
      }
      data-entries={JSON.stringify(entries)}
    />
  ),
}));

vi.mock("@/components/analytics/harness-cards", () => ({
  AnalyticsHarnessCards: ({ entries }: { entries?: AnalyticsBreakdownResponse["entries"] }) => (
    <div data-testid="analytics-harness-cards" data-entries={JSON.stringify(entries)} />
  ),
}));

vi.mock("@/components/analytics/runs-table", () => ({
  AnalyticsRunsTable: ({ runs }: { runs?: unknown[] }) => (
    <div data-testid="analytics-runs-table" data-runs={JSON.stringify(runs)} />
  ),
}));

vi.mock("@/components/analytics/pull-request-cost-table", () => ({
  AnalyticsPullRequestCostTable: ({ title, entries }: { title: string; entries?: unknown[] }) => (
    <div
      data-testid={
        title === "Cost by Model" ? "analytics-pr-model-cost" : "analytics-pr-harness-cost"
      }
      data-entries={JSON.stringify(entries)}
    />
  ),
}));

vi.mock("@/components/analytics/pull-request-cards", () => ({
  AnalyticsPullRequestCards: () => <div data-testid="analytics-pr-cards" />,
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
  ...zeroTokens,
  cacheHitRatio: null,
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
      ...zeroTokens,
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
      ...zeroTokens,
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
      ...zeroTokens,
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
      ...zeroTokens,
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
  it("shows automation only for automation and all scopes and orders the new views", async () => {
    const user = userEvent.setup();
    renderPage();
    mockUseAnalyticsDashboard.mockImplementation(() => ({
      summary,
      timeseries,
      repoBreakdown,
      userBreakdown,
      harnessBreakdown: { entries: [repoBreakdown.entries[0]] },
      automationBreakdown: { entries: [repoBreakdown.entries[0]] },
      runs: [{ rootSessionId: "root-1" }],
      pullRequests: { models: [{ key: "model-1" }], harnesses: [{ key: "harness-1" }] },
      loading: false,
    }));

    expect(screen.queryByTestId("analytics-automation-table")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Agents" }));
    expect(screen.queryByTestId("analytics-automation-table")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Automations" }));
    expect(screen.getByTestId("analytics-automation-table")).toHaveAttribute(
      "data-entries",
      JSON.stringify([repoBreakdown.entries[0]])
    );
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByTestId("analytics-automation-table")).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Human" }));
    expect(screen.queryByTestId("analytics-automation-table")).not.toBeInTheDocument();

    expect(screen.getByTestId("analytics-harness-cards")).toHaveAttribute(
      "data-entries",
      JSON.stringify([repoBreakdown.entries[0]])
    );
    expect(screen.getByTestId("analytics-runs-table")).toHaveAttribute(
      "data-runs",
      JSON.stringify([{ rootSessionId: "root-1" }])
    );
    expect(screen.getByTestId("analytics-pr-model-cost")).toHaveAttribute(
      "data-entries",
      JSON.stringify([{ key: "model-1" }])
    );
    expect(screen.getByTestId("analytics-pr-harness-cost")).toHaveAttribute(
      "data-entries",
      JSON.stringify([{ key: "harness-1" }])
    );
    const widgets = Array.from(document.querySelectorAll("[data-testid]")).map((node) =>
      node.getAttribute("data-testid")
    );
    expect(widgets.indexOf("analytics-harness-cards")).toBeGreaterThan(
      widgets.indexOf("analytics-provider-table")
    );
    expect(widgets.indexOf("analytics-runs-table")).toBeGreaterThan(
      widgets.indexOf("analytics-harness-cards")
    );
    expect(widgets.indexOf("analytics-pr-model-cost")).toBeGreaterThan(
      widgets.indexOf("analytics-pr-cards")
    );
    expect(widgets.indexOf("analytics-pr-harness-cost")).toBeGreaterThan(
      widgets.indexOf("analytics-pr-model-cost")
    );
  });

  it("refetches analytics when the selected range changes", async () => {
    const user = userEvent.setup();

    renderPage();

    expect(mockUseAnalyticsDashboard).toHaveBeenCalledWith(30, "human");

    await user.click(screen.getByRole("radio", { name: "7d" }));

    await waitFor(() => {
      expect(mockUseAnalyticsDashboard).toHaveBeenLastCalledWith(7, "human");
    });
  });

  it("refetches analytics when the selected scope changes", async () => {
    const user = userEvent.setup();
    renderPage();
    mockUseAnalyticsDashboard.mockImplementation((_days, selectedScope) => ({
      summary,
      timeseries,
      repoBreakdown,
      userBreakdown,
      modelBreakdown: {
        entries: [
          {
            ...repoBreakdown.entries[0],
            key: "anthropic/sonnet",
            cost: selectedScope === "agent" ? 7 : 2,
          },
        ],
      },
      loading: false,
    }));

    expect(screen.getByRole("radio", { name: "Human" })).toHaveAttribute("data-state", "on");
    expect(
      screen.getByText(/Automations: sessions started by automations\. All: every session\./)
    ).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Agents" }));

    await waitFor(() => {
      expect(mockUseAnalyticsDashboard).toHaveBeenLastCalledWith(30, "agent");
    });
    expect(screen.getByTestId("analytics-token-cards")).toBeInTheDocument();
    expect(screen.getByTestId("analytics-model-chart")).toBeInTheDocument();
    expect(
      JSON.parse(screen.getByTestId("analytics-model-chart").dataset.entries ?? "[]")
    ).toMatchObject([{ key: "anthropic/sonnet", cost: 7 }]);
    expect(screen.getByTestId("analytics-provider-table")).toBeInTheDocument();
  });

  it("renders cached dimensions when a refresh fails without summary data", () => {
    mockUseSidebarContext.mockReturnValue({ isOpen: true });
    mockUseAnalyticsDashboard.mockReturnValue({
      modelBreakdown: { entries: [{ key: "a" }] },
      error: new Error("request failed"),
      loading: false,
    });

    render(<AnalyticsPage />);

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("analytics-model-chart")).toBeInTheDocument();
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
