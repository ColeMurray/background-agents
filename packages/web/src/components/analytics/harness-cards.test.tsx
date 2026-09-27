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
  cost: 12.5,
  prs: 4,
  inputTokens: 60,
  outputTokens: 20,
  reasoningTokens: 5,
  cacheReadTokens: 40,
  cacheWriteTokens: 0,
  messageCount: 10,
  avgDuration: 1000,
  lastActive: 1,
};

it("renders per-harness sessions, cost, completion, PRs and cache ratio", () => {
  render(
    <AnalyticsHarnessCards
      entries={[
        entry,
        { ...entry, key: "other", displayName: undefined, cacheReadTokens: 0, inputTokens: 0 },
      ]}
      loading={false}
    />
  );

  const card = within(screen.getAllByRole("article")[0]);
  expect(card.getByText("OpenCode")).toBeInTheDocument();
  expect(card.getByText("1,250")).toBeInTheDocument();
  expect(card.getByText("$12.50")).toBeInTheDocument();
  expect(card.getByText("75%")).toBeInTheDocument();
  expect(card.getByText("4")).toBeInTheDocument();
  expect(card.getByText("40%")).toBeInTheDocument();
  expect(screen.getByText("other")).toBeInTheDocument();
  expect(screen.getByText("\u2014")).toBeInTheDocument();
});

it("shows empty and loading panels instead of empty cards", () => {
  const { rerender } = render(<AnalyticsHarnessCards entries={[]} loading={false} />);
  expect(screen.getByText("No harness data found for this range.")).toBeInTheDocument();

  rerender(<AnalyticsHarnessCards loading />);
  expect(screen.queryByText("No harness data found for this range.")).not.toBeInTheDocument();
  expect(screen.queryByRole("article")).not.toBeInTheDocument();
});
