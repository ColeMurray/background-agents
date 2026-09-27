// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import type { AnalyticsSummaryResponse } from "@open-inspect/shared/types/analytics";
import { AnalyticsTokenCards } from "./token-cards";

expect.extend(matchers);
afterEach(cleanup);

const summary: AnalyticsSummaryResponse = {
  totalSessions: 2,
  activeUsers: 1,
  totalCost: 1,
  avgCost: 0.5,
  totalPrs: 0,
  statusBreakdown: { created: 0, active: 0, completed: 2, failed: 0, archived: 0, cancelled: 0 },
  inputTokens: 12345,
  outputTokens: 6789,
  cacheReadTokens: 5432,
  cacheWriteTokens: 0,
  reasoningTokens: 321,
  cacheHitRatio: null,
};

it("renders token totals and derives cache hit ratio from the token counts", () => {
  render(<AnalyticsTokenCards summary={summary} loading={false} />);

  expect(screen.getByText("12,345")).toBeInTheDocument();
  expect(screen.getByText("6,789")).toBeInTheDocument();
  expect(screen.getByText("321")).toBeInTheDocument();
  expect(screen.getByText("31%")).toBeInTheDocument();
  expect(screen.getByText("reported by OpenCode only")).toBeInTheDocument();
  expect(screen.getByText(/older sessions count as zero/)).toBeInTheDocument();
});

it("shows zero tokens and an unknown ratio for an empty snapshot", () => {
  render(
    <AnalyticsTokenCards
      summary={{
        ...summary,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      }}
      loading={false}
    />
  );

  expect(screen.getAllByText("0")).toHaveLength(3);
  expect(screen.getByText("—")).toBeInTheDocument();
});

it("shows an empty message and a loading placeholder when data is unavailable", () => {
  const { rerender } = render(<AnalyticsTokenCards loading={false} />);
  expect(screen.getByText(/No token data found/)).toBeInTheDocument();

  rerender(<AnalyticsTokenCards loading />);
  expect(screen.queryByText(/No token data found/)).not.toBeInTheDocument();
  expect(screen.queryByText("Input tokens")).not.toBeInTheDocument();
});
