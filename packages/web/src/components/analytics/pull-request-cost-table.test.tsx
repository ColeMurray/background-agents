// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import type { AnalyticsPullRequestsResponse } from "@open-inspect/shared/types/analytics";
import { analyticsDashboard } from "@/lib/analytics.test-fixture";
import { AnalyticsPullRequestCostTable } from "./pull-request-cost-table";

expect.extend(matchers);
afterEach(cleanup);

function pullRequests(
  overrides: Partial<AnalyticsPullRequestsResponse>
): AnalyticsPullRequestsResponse {
  return { ...analyticsDashboard().pullRequests, ...overrides };
}

it("renders created, merged and cost per merged PR with a zero-merge placeholder", () => {
  render(
    <AnalyticsPullRequestCostTable
      pullRequests={pullRequests({
        models: [
          { key: "model-1", displayName: "Model One", created: 1200, merged: 2, sessionCost: 3 },
          { key: "model-2", created: 1, merged: 0, sessionCost: 1 },
        ],
      })}
    />
  );
  expect(screen.getByRole("columnheader", { name: "Cost per merged PR" })).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Model One/ })).toHaveTextContent("1,200");
  expect(screen.getByRole("row", { name: /Model One/ })).toHaveTextContent("$1.50");
  expect(within(screen.getByRole("row", { name: /model-2/ })).getByText("—")).toBeInTheDocument();
});

it("switches between models and harnesses", async () => {
  const user = userEvent.setup();
  render(<AnalyticsPullRequestCostTable pullRequests={pullRequests({})} />);

  expect(screen.getByRole("table", { name: "Cost per merged PR by model" })).toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Harnesses" }));
  expect(screen.getByRole("table", { name: "Cost per merged PR by harness" })).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /OpenCode/ })).toHaveTextContent("$1.50");
});

it("shows distinct model keys when display names collide", () => {
  render(
    <AnalyticsPullRequestCostTable
      pullRequests={pullRequests({
        models: [
          {
            key: "opencode/glm-5.1",
            displayName: "GLM 5.1",
            created: 1,
            merged: 1,
            sessionCost: 1,
          },
          {
            key: "opencode-go/glm-5.1",
            displayName: "GLM 5.1",
            created: 1,
            merged: 1,
            sessionCost: 1,
          },
        ],
      })}
    />
  );
  expect(screen.getByRole("row", { name: /opencode\/glm-5.1/ })).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /opencode-go\/glm-5.1/ })).toBeInTheDocument();
});

it("shows an empty message", () => {
  render(<AnalyticsPullRequestCostTable pullRequests={pullRequests({ models: [] })} />);
  expect(screen.getByText("No pull request cost data found for this range.")).toBeInTheDocument();
});
