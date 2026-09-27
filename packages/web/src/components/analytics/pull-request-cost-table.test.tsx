// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import { AnalyticsPullRequestCostTable } from "./pull-request-cost-table";

expect.extend(matchers);
afterEach(cleanup);

it("renders created, merged and cost per merged PR with a zero-merge placeholder", () => {
  render(
    <AnalyticsPullRequestCostTable
      title="Cost by Model"
      entries={[
        { key: "model-1", displayName: "Model One", created: 1200, merged: 2, sessionCost: 3 },
        { key: "model-2", created: 1, merged: 0, sessionCost: 4 },
      ]}
      loading={false}
    />
  );

  expect(screen.getByRole("heading", { name: "Cost by Model" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Cost per merged PR" })).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Model One/ })).toHaveTextContent("1,200");
  expect(screen.getByRole("row", { name: /Model One/ })).toHaveTextContent("$1.50");
  expect(within(screen.getByRole("row", { name: /model-2/ })).getByText("—")).toBeInTheDocument();
});

it("renders an empty panel and a loading placeholder", () => {
  const { rerender } = render(
    <AnalyticsPullRequestCostTable title="Cost by Harness" entries={[]} loading={false} />
  );
  expect(screen.getByText("No pull request cost data found for this range.")).toBeInTheDocument();

  rerender(<AnalyticsPullRequestCostTable title="Cost by Harness" loading />);
  expect(
    screen.queryByText("No pull request cost data found for this range.")
  ).not.toBeInTheDocument();
  expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
});
