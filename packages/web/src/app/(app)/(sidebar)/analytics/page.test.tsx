// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { AnalyticsDashboardResponse } from "@open-inspect/shared/types/analytics";
import type * as TrendChartModule from "@/components/analytics/analytics-trend-chart";
import { analyticsDashboard } from "@/lib/analytics.test-fixture";
import AnalyticsPage from "./page";

expect.extend(matchers);

const { mockReplace, mockSearchParams, mockUseAnalyticsDashboard } = vi.hoisted(() => ({
  mockReplace: vi.fn(),
  mockSearchParams: { value: new URLSearchParams() },
  mockUseAnalyticsDashboard: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/analytics",
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => mockSearchParams.value,
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={typeof href === "string" ? href : "#"} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-analytics", () => ({
  useAnalyticsDashboard: mockUseAnalyticsDashboard,
}));

vi.mock("@/components/sidebar-layout", () => ({
  CollapsedSidebarControls: () => null,
  useSidebarContext: () => ({ isOpen: true }),
}));

// Charts need layout jsdom does not have; the panels around them are what is under test.
vi.mock("@/components/analytics/analytics-trend-chart", async (importOriginal) => ({
  ...(await importOriginal<typeof TrendChartModule>()),
  AnalyticsTrendChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="trend-chart" data-points={data.length} />
  ),
}));

function dashboardResult(
  overrides: Partial<{
    dashboard: AnalyticsDashboardResponse | undefined;
    loading: boolean;
    stale: boolean;
    error: unknown;
  }> = {}
) {
  return {
    dashboard: analyticsDashboard(),
    loading: false,
    stale: false,
    error: undefined,
    ...overrides,
  };
}

function renderAt(search: string, result = dashboardResult()) {
  mockSearchParams.value = new URLSearchParams(search);
  mockUseAnalyticsDashboard.mockReturnValue(result);
  return render(<AnalyticsPage />);
}

beforeEach(() => {
  mockReplace.mockReset();
  mockUseAnalyticsDashboard.mockReset();
});

afterEach(cleanup);

describe("AnalyticsPage", () => {
  it("opens on the overview with headline numbers grouped by what scope applies to", () => {
    renderAt("");

    expect(mockUseAnalyticsDashboard).toHaveBeenCalledWith(30, "human");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("region", { name: "Human sessions" })).toHaveTextContent("12");
    expect(screen.getByRole("region", { name: "Pull requests · every source" })).toHaveTextContent(
      "$1.50"
    );
    expect(screen.getByRole("region", { name: "Top repositories" })).toHaveTextContent("web");
    expect(screen.getAllByTestId("trend-chart")[0]).toHaveAttribute("data-points", "8");
  });

  it("requests the range and scope in the URL and opens the tab it names", () => {
    renderAt("days=7&scope=agent&tab=cost");

    expect(mockUseAnalyticsDashboard).toHaveBeenCalledWith(7, "agent");
    expect(screen.getByRole("tab", { name: "Cost" })).toHaveAttribute("data-state", "active");
    expect(screen.getByRole("radio", { name: "7d" })).toHaveAttribute("data-state", "on");
    expect(screen.getByRole("radio", { name: "Agents" })).toHaveAttribute("data-state", "on");
    expect(screen.getByRole("region", { name: "By provider" })).toBeInTheDocument();
  });

  it("writes filter changes to the URL and keeps the open tab", async () => {
    const user = userEvent.setup();
    renderAt("tab=cost");

    await user.click(screen.getByRole("radio", { name: "7d" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/analytics?tab=cost&days=7", { scroll: false });

    await user.click(screen.getByRole("radio", { name: "Automations" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/analytics?tab=cost&scope=automation", {
      scroll: false,
    });
  });

  it("switches tabs through the URL, including from overview links", async () => {
    const user = userEvent.setup();
    renderAt("days=14");

    await user.click(screen.getByRole("tab", { name: "Pull requests" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/analytics?days=14&tab=pull-requests", {
      scroll: false,
    });

    const topPeople = screen.getByRole("region", { name: "Most active people" });
    await user.click(within(topPeople).getByRole("button", { name: "People" }));
    expect(mockReplace).toHaveBeenLastCalledWith("/analytics?days=14&tab=people", {
      scroll: false,
    });
  });

  it("turns the scope control off on the pull requests tab, where it does not apply", () => {
    renderAt("tab=pull-requests");

    for (const scope of ["Human", "Agents", "Automations", "All"]) {
      expect(screen.getByRole("radio", { name: scope })).toBeDisabled();
    }
    expect(screen.getByRole("radio", { name: "30d" })).toBeEnabled();
    expect(screen.getByRole("region", { name: "By repository" })).toBeInTheDocument();
  });

  it("shows automations only for automation and all scopes", () => {
    const { unmount } = renderAt("tab=usage");
    expect(screen.queryByRole("region", { name: "Automations" })).not.toBeInTheDocument();
    unmount();

    const dashboard = analyticsDashboard();
    for (const scope of ["automation", "all"] as const) {
      const view = renderAt(
        `tab=usage&scope=${scope}`,
        dashboardResult({ dashboard: { ...dashboard, window: { ...dashboard.window, scope } } })
      );
      expect(screen.getByRole("region", { name: "Automations" })).toBeInTheDocument();
      view.unmount();
    }
  });

  it("resets the source selection when the range or scope changes", async () => {
    const user = userEvent.setup();
    const { rerender } = renderAt("tab=usage");
    const sources = () => screen.getByRole("region", { name: "Where sessions start" });

    await user.click(within(sources()).getByRole("button", { name: /Slack/ }));
    expect(within(sources()).getByRole("button", { name: /Slack/ })).toHaveAttribute(
      "aria-pressed",
      "true"
    );

    mockSearchParams.value = new URLSearchParams("tab=usage&days=7");
    rerender(<AnalyticsPage />);
    expect(within(sources()).getByRole("button", { name: "All sources" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("keeps cached numbers on screen behind the error alert", () => {
    renderAt("", dashboardResult({ error: new Error("refresh failed") }));

    expect(screen.getByRole("alert")).toHaveTextContent("Analytics failed to load");
    expect(screen.getByRole("region", { name: "Human sessions" })).toBeInTheDocument();
  });

  it("shows only the alert when loading fails with nothing cached", () => {
    renderAt("", dashboardResult({ dashboard: undefined, error: new Error("request failed") }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Human sessions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("dims the previous snapshot while a new range loads, and shows a placeholder at first", () => {
    const { unmount } = renderAt("", dashboardResult({ stale: true }));
    expect(
      screen.getByRole("region", { name: "Human sessions" }).closest("[aria-busy]")
    ).toHaveAttribute("aria-busy", "true");
    unmount();

    renderAt("", dashboardResult({ dashboard: undefined, loading: true }));
    expect(screen.getByRole("status", { name: "Loading analytics" })).toBeInTheDocument();
  });
});
