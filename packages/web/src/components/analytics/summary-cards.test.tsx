// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect, it } from "vitest";
import { AnalyticsSummaryCards } from "./summary-cards";

expect.extend(matchers);

it("leaves the dedicated PR funnel as the only top-level PR-created metric", () => {
  render(
    <AnalyticsSummaryCards
      days={30}
      loading={false}
      summary={{
        totalSessions: 10,
        activeUsers: 2,
        totalCost: 5,
        avgCost: 0.5,
        totalPrs: 99,
        statusBreakdown: {
          created: 1,
          active: 1,
          completed: 6,
          failed: 1,
          archived: 0,
          cancelled: 1,
        },
      }}
    />
  );

  expect(screen.getByText("Total Sessions")).toBeInTheDocument();
  expect(screen.getByText("Active Users")).toBeInTheDocument();
  expect(screen.getByText("Total Cost")).toBeInTheDocument();
  expect(screen.getByText("Avg Cost / Session")).toBeInTheDocument();
  expect(screen.queryByText("PRs Created")).not.toBeInTheDocument();
  expect(screen.queryByText("99")).not.toBeInTheDocument();
});
