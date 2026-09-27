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
  title: "Fix the build",
  sessionCount: 1200,
  maxSpawnDepth: 2,
  totalCost: 3.5,
  totalPrs: 4,
  inputTokens: 1000,
  outputTokens: 234,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  createdAt: Date.UTC(2026, 8, 27, 10),
  updatedAt: Date.UTC(2026, 8, 27, 11),
  userId: null,
  scmLogin: null,
  spawnSource: "user",
  automationId: null,
  repoOwner: null,
  repoName: null,
};

it("renders runs in server order with links, token totals and relative start time", () => {
  vi.setSystemTime(Date.UTC(2026, 8, 27, 12));
  render(
    <AnalyticsRunsTable
      runs={[run, { ...run, rootSessionId: "root-2", title: null, totalCost: 0 }]}
      loading={false}
    />
  );

  const rows = screen.getAllByRole("row").slice(1);
  expect(within(rows[0]).getByRole("link", { name: "Fix the build" })).toHaveAttribute(
    "href",
    "/session/root-1"
  );
  expect(rows[0]).toHaveTextContent("1,200");
  expect(rows[0]).toHaveTextContent("2");
  expect(rows[0]).toHaveTextContent("$3.50");
  expect(rows[0]).toHaveTextContent("4");
  expect(rows[0]).toHaveTextContent("1,234");
  expect(rows[0]).toHaveTextContent("2h");
  expect(within(rows[1]).getByRole("link", { name: "Untitled session" })).toHaveAttribute(
    "href",
    "/session/root-2"
  );
});

it("shows an empty panel or a loading placeholder", () => {
  const { rerender } = render(<AnalyticsRunsTable runs={[]} loading={false} />);
  expect(screen.getByText("No runs found for this range.")).toBeInTheDocument();

  rerender(<AnalyticsRunsTable loading />);
  expect(screen.queryByText("No runs found for this range.")).not.toBeInTheDocument();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
