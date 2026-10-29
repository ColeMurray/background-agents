// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";
import { analyticsDashboard, breakdownEntry } from "@/lib/analytics.test-fixture";
import { AnalyticsCostTable, type AnalyticsCostDimension } from "./cost-table";

expect.extend(matchers);
afterEach(cleanup);

function renderTable(dimension: AnalyticsCostDimension, entries: AnalyticsBreakdownEntry[]) {
  const dashboard = analyticsDashboard();
  return render(
    <AnalyticsCostTable
      dashboard={{
        ...dashboard,
        breakdowns: { ...dashboard.breakdowns, [dimension]: { entries } },
      }}
      dimension={dimension}
    />
  );
}

const anthropic = breakdownEntry("anthropic", {
  displayName: "Anthropic",
  sessions: 1250,
  subscriptionSessions: 123,
  cost: 3.5,
  inputTokens: 58,
  cacheReadTokens: 42,
});

describe("AnalyticsCostTable", () => {
  it("renders provider sessions, subscription sessions, cost and cache ratio", () => {
    renderTable("provider", [anthropic]);
    expect(screen.getByRole("columnheader", { name: "Provider" })).toBeInTheDocument();
    const row = screen.getByRole("row", { name: /Anthropic/ });
    expect(row).toHaveTextContent("1,250");
    expect(row).toHaveTextContent("123");
    expect(row).toHaveTextContent("$3.50");
    expect(row).toHaveTextContent("42%");
  });

  it("distinguishes missing subscription counts from zero and shows unknown ratios", () => {
    renderTable("provider", [
      { ...anthropic, subscriptionSessions: undefined, inputTokens: 0, cacheReadTokens: 0 },
      { ...anthropic, key: "other", displayName: "Other", subscriptionSessions: 0 },
    ]);
    expect(within(screen.getByRole("row", { name: /Anthropic/ })).getAllByText("—")).toHaveLength(
      2
    );
    expect(within(screen.getByRole("row", { name: /Other/ })).getByText("0")).toBeInTheDocument();
  });

  it("orders by spend and shows cost per session", () => {
    renderTable("model", [
      breakdownEntry("cheap", { displayName: "Cheap", sessions: 10, cost: 1 }),
      breakdownEntry("dear", { displayName: "Dear", sessions: 2, cost: 9 }),
    ]);
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Dear");
    expect(rows[0]).toHaveTextContent("$4.50");
  });

  it("renders automation completion and PRs, and distinct keys for duplicate names", () => {
    renderTable("automation", [
      breakdownEntry("automation-1", { displayName: "Daily", completed: 4, failed: 0, prs: 2 }),
      breakdownEntry("automation-2", { displayName: "Daily" }),
    ]);
    expect(screen.getByRole("columnheader", { name: "Completion" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "PRs" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /automation-1/ })).toHaveTextContent("100%");
    expect(screen.getByRole("row", { name: /automation-2/ })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "On subscription" })).not.toBeInTheDocument();
  });

  it("shows the dimension's empty message", () => {
    renderTable("harness", []);
    expect(screen.getByText("No harness data found for this range.")).toBeInTheDocument();
  });
});
