// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionRun } from "@open-inspect/shared/types/analytics";
import { AnalyticsRunsTable } from "./runs-table";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const run: SessionRun = {
  rootSessionId: "root-1",
  title: "Fix a bug",
  sessionCount: 1234,
  maxSpawnDepth: 2,
  totalCost: 2.5,
  totalPrs: 3,
  inputTokens: 1200,
  outputTokens: 345,
  reasoningTokens: 200,
  cacheReadTokens: 400,
  cacheWriteTokens: 50,
  createdAt: Date.UTC(2026, 8, 27, 10),
  updatedAt: Date.UTC(2026, 8, 27, 11),
  userId: null,
  scmLogin: null,
  spawnSource: "user",
  automationId: null,
  repoOwner: null,
  repoName: null,
};

it("renders runs in server order with root links, token totals and start times", () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 8, 27, 12));
  render(
    <AnalyticsRunsTable
      runs={[run, { ...run, rootSessionId: "root-2", title: null }]}
      loading={false}
    />
  );

  const rows = screen.getAllByRole("row").slice(1);
  expect(screen.getByRole("columnheader", { name: "Input + output tokens" })).toBeInTheDocument();
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByRole("link", { name: "Fix a bug" })).toHaveAttribute(
    "href",
    "/session/root-1"
  );
  expect(rows[0]).toHaveTextContent("1,234");
  expect(rows[0]).toHaveTextContent("2");
  expect(rows[0]).toHaveTextContent("$2.50");
  expect(rows[0]).toHaveTextContent("3");
  expect(rows[0]).toHaveTextContent("1,545");
  expect(rows[0]).toHaveTextContent("2h");
  expect(within(rows[1]).getByRole("link", { name: "Untitled session" })).toHaveAttribute(
    "href",
    "/session/root-2"
  );
});

it("describes the dashboard runs as the top 20 by cost", () => {
  render(<AnalyticsRunsTable runs={[run]} loading={false} />);

  expect(
    screen.getByText("Top 20 runs by cost. Root sessions and their descendants.")
  ).toBeInTheDocument();
});

it("renders an empty panel and a loading placeholder", () => {
  const { rerender } = render(<AnalyticsRunsTable runs={[]} loading={false} />);
  expect(screen.getByText("No runs found for this range.")).toBeInTheDocument();

  rerender(<AnalyticsRunsTable loading />);
  expect(screen.queryByText("No runs found for this range.")).not.toBeInTheDocument();
  expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
});
