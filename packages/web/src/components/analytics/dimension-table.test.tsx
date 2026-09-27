// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it } from "vitest";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";
import { AnalyticsDimensionTable } from "./dimension-table";

expect.extend(matchers);
afterEach(cleanup);

const entry: AnalyticsBreakdownEntry = {
  key: "anthropic",
  displayName: "Anthropic",
  sessions: 1250,
  subscriptionSessions: 123,
  cost: 3.5,
  prs: 2,
  completed: 1000,
  failed: 0,
  cancelled: 0,
  inputTokens: 58,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 42,
  cacheWriteTokens: 0,
  messageCount: 10,
  avgDuration: 1000,
  lastActive: 1,
};

const props = {
  title: "Providers",
  description: "Cost and billing by provider.",
  keyLabel: "Provider",
  emptyMessage: "No providers found for this range.",
  columns: ["subscriptionSessions", "cost", "cacheHitRatio"] as const,
};

it("renders provider counts, subscription sessions, cost, and cache ratio", () => {
  render(<AnalyticsDimensionTable {...props} entries={[entry]} loading={false} />);

  expect(screen.getByRole("heading", { name: "Providers" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "Provider" })).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("1,250");
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("123");
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("$3.50");
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("42%");
  expect(screen.getByText("Sessions billed to a subscription report $0.")).toBeInTheDocument();
});

it("distinguishes missing subscription counts from zero and shows unknown ratios", () => {
  render(
    <AnalyticsDimensionTable
      {...props}
      entries={[
        { ...entry, subscriptionSessions: undefined, inputTokens: 0, cacheReadTokens: 0 },
        { ...entry, key: "other", displayName: "Other", subscriptionSessions: 0 },
      ]}
      loading={false}
    />
  );
  expect(within(screen.getByRole("row", { name: /Anthropic/ })).getAllByText("—")).toHaveLength(2);
  expect(screen.getByRole("row", { name: /Other/ })).toHaveTextContent("0");
});

it("renders the supplied empty message or a loading placeholder", () => {
  const { rerender } = render(<AnalyticsDimensionTable {...props} entries={[]} loading={false} />);
  expect(screen.getByText(props.emptyMessage)).toBeInTheDocument();

  rerender(<AnalyticsDimensionTable {...props} loading />);
  expect(screen.queryByText(props.emptyMessage)).not.toBeInTheDocument();
});

it("renders automation completion rate and PR totals in the existing dimension table", () => {
  render(
    <AnalyticsDimensionTable
      title="Automations"
      description="Automated session usage."
      keyLabel="Automation"
      emptyMessage="No automation data found for this range."
      columns={["completionRate", "cost", "prs"]}
      entries={[entry]}
      loading={false}
    />
  );

  expect(screen.getByRole("columnheader", { name: "Completion rate" })).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "PRs" })).toBeInTheDocument();
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("100%");
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("$3.50");
  expect(screen.getByRole("row", { name: /Anthropic/ })).toHaveTextContent("2");
});
