// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it, vi } from "vitest";
import { analyticsDashboard, FIXTURE_NOW, sessionRun } from "@/lib/analytics.test-fixture";
import { AnalyticsRunsTable } from "./runs-table";

expect.extend(matchers);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("renders runs in server order with root links, attribution, token totals and start times", () => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXTURE_NOW);
  render(
    <AnalyticsRunsTable
      dashboard={analyticsDashboard({
        runs: [
          sessionRun("root-1", { sessionCount: 1234, maxSpawnDepth: 2, totalPrs: 3 }),
          sessionRun("root-2", { title: null, totalCost: 9, userId: null }),
        ],
      })}
    />
  );

  const rows = screen.getAllByRole("row").slice(1);
  expect(screen.getByRole("columnheader", { name: "Input + output tokens" })).toBeInTheDocument();
  expect(rows).toHaveLength(2);
  expect(within(rows[0]).getByRole("link", { name: "Fix a bug" })).toHaveAttribute(
    "href",
    "/session/root-1"
  );
  expect(rows[0]).toHaveTextContent("Zoe · User / app · web");
  expect(rows[0]).toHaveTextContent("1,234");
  expect(rows[0]).toHaveTextContent("$2.50");
  expect(rows[0]).toHaveTextContent("1,545");
  expect(rows[0]).toHaveTextContent("2h");
  expect(within(rows[1]).getByRole("link", { name: "Untitled session" })).toHaveAttribute(
    "href",
    "/session/root-2"
  );
  expect(rows[1]).toHaveTextContent("User / app · web");
});

it("shows an empty message", () => {
  render(<AnalyticsRunsTable dashboard={analyticsDashboard({ runs: [] })} />);
  expect(screen.getByText("No runs found for this range.")).toBeInTheDocument();
});
