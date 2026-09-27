// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import type { AnalyticsPullRequestDimensionEntry } from "@open-inspect/shared/types/analytics";
import { AnalyticsPullRequestCostTable } from "./pull-request-cost-table";

expect.extend(matchers);
afterEach(cleanup);

const entry: AnalyticsPullRequestDimensionEntry = {
  key: "anthropic/sonnet",
  displayName: "Sonnet",
  created: 1200,
  merged: 2,
  sessionCost: 7.5,
};

it("renders per-merged-PR session cost and excludes unmerged rows from division", () => {
  render(
    <AnalyticsPullRequestCostTable
      title="Cost by Model"
      entries={[entry, { ...entry, key: "other", displayName: undefined, merged: 0 }]}
      loading={false}
    />
  );

  expect(screen.getByRole("columnheader", { name: "Cost per merged PR" })).toBeInTheDocument();
  const sonnet = screen.getByRole("row", { name: /Sonnet/ });
  expect(sonnet).toHaveTextContent("1,200");
  expect(sonnet).toHaveTextContent("2");
  expect(sonnet).toHaveTextContent("$3.75");
  expect(
    within(screen.getByRole("row", { name: /other/ })).getByText("\u2014")
  ).toBeInTheDocument();
});

it("distinguishes raw model aliases with the same display name", () => {
  render(
    <AnalyticsPullRequestCostTable
      title="Cost by Model"
      entries={[
        { ...entry, key: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
        { ...entry, key: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
      ]}
      loading={false}
    />
  );

  const rows = screen.getAllByRole("row").slice(1);
  expect(within(rows[0]).getByText("claude-haiku-4-5")).toBeInTheDocument();
  expect(within(rows[1]).getByText("anthropic/claude-haiku-4-5")).toBeInTheDocument();
});

it("shows the titled empty panel or a loading placeholder", () => {
  const { rerender } = render(
    <AnalyticsPullRequestCostTable title="Cost by Harness" entries={[]} loading={false} />
  );
  expect(screen.getByText("Cost by Harness")).toBeInTheDocument();
  expect(screen.getByText("No pull request cost data found for this range.")).toBeInTheDocument();

  rerender(<AnalyticsPullRequestCostTable title="Cost by Harness" loading />);
  expect(
    screen.queryByText("No pull request cost data found for this range.")
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
