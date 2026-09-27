// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";
import { AnalyticsHarnessCards } from "./harness-cards";

expect.extend(matchers);
afterEach(cleanup);

const entry: AnalyticsBreakdownEntry = {
  key: "opencode",
  displayName: "OpenCode",
  sessions: 1250,
  completed: 3,
  failed: 1,
  cancelled: 0,
  cost: 3.5,
  prs: 2,
  inputTokens: 60,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 40,
  cacheWriteTokens: 0,
  messageCount: 10,
  avgDuration: 1000,
  lastActive: 1,
};

it("renders one card per harness with counts, cost, completion and cache ratio", () => {
  render(
    <AnalyticsHarnessCards
      entries={[
        entry,
        { ...entry, key: "other", displayName: undefined, cacheReadTokens: 0, inputTokens: 0 },
      ]}
      loading={false}
    />
  );

  const cards = screen.getAllByRole("article");
  expect(cards).toHaveLength(2);
  expect(within(cards[0]).getByText("OpenCode")).toBeInTheDocument();
  expect(cards[0]).toHaveTextContent("1,250");
  expect(cards[0]).toHaveTextContent("$3.50");
  expect(cards[0]).toHaveTextContent("75%");
  expect(cards[0]).toHaveTextContent("2");
  expect(cards[0]).toHaveTextContent("40%");
  expect(within(cards[1]).getByText("other")).toBeInTheDocument();
  expect(cards[1]).toHaveTextContent("—");
});

it("renders an empty panel and a loading placeholder", () => {
  const { rerender } = render(<AnalyticsHarnessCards entries={[]} loading={false} />);
  expect(screen.getByText("No harness data found for this range.")).toBeInTheDocument();

  rerender(<AnalyticsHarnessCards loading />);
  expect(screen.queryByText("No harness data found for this range.")).not.toBeInTheDocument();
  expect(document.querySelector(".animate-pulse")).toBeInTheDocument();
});
