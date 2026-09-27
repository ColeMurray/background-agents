// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, expect, it, vi } from "vitest";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";
import { AnalyticsModelBarChart } from "./model-bar-chart";

expect.extend(matchers);
afterEach(cleanup);

const chartRows = vi.hoisted(() => ({ current: [] as Record<string, unknown>[] }));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BarChart: ({ data, children }: { data: Record<string, unknown>[]; children: ReactNode }) => {
    chartRows.current = data;
    return (
      <div data-testid="chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    );
  },
  Bar: ({ dataKey }: { dataKey: string }) => <div data-testid="bar" data-key={dataKey} />,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: ({
    content,
  }: {
    content: (props: { active: boolean; payload: { payload: unknown }[] }) => ReactNode;
  }) => (
    <div data-testid="tooltip">
      {content({ active: true, payload: [{ payload: chartRows.current[0] }] })}
    </div>
  ),
}));

const entry: AnalyticsBreakdownEntry = {
  key: "anthropic/sonnet",
  displayName: "Sonnet",
  sessions: 1200,
  completed: 1000,
  failed: 0,
  cancelled: 0,
  cost: 3.5,
  prs: 2,
  inputTokens: 58,
  outputTokens: 10,
  reasoningTokens: 0,
  cacheReadTokens: 42,
  cacheWriteTokens: 0,
  messageCount: 10,
  avgDuration: 1000,
  lastActive: 1,
};

it("charts cost by display name and shows sessions, cost, PRs and cache ratio in the tooltip", () => {
  render(
    <AnalyticsModelBarChart
      entries={[entry, { ...entry, key: "other/model", displayName: undefined, cost: 1 }]}
      loading={false}
    />
  );

  expect(screen.getByTestId("bar")).toHaveAttribute("data-key", "cost");
  expect(JSON.parse(screen.getByTestId("chart").getAttribute("data-rows") ?? "[]")).toMatchObject([
    { model: "Sonnet", cost: 3.5, cacheHitRatio: 0.42 },
    { model: "other/model", cost: 1 },
  ]);
  expect(screen.getByTestId("tooltip")).toHaveTextContent("1,200");
  expect(screen.getByTestId("tooltip")).toHaveTextContent("$3.50");
  expect(screen.getByTestId("tooltip")).toHaveTextContent("2");
  expect(screen.getByTestId("tooltip")).toHaveTextContent("42%");
});

it("uses unique model keys on the axis when display names collide and identifies the key in the tooltip", () => {
  render(
    <AnalyticsModelBarChart
      entries={[
        { ...entry, key: "opencode/kimi-k3", displayName: "Kimi K3" },
        { ...entry, key: "opencode-go/kimi-k3", displayName: "Kimi K3", cost: 2 },
      ]}
      loading={false}
    />
  );

  expect(JSON.parse(screen.getByTestId("chart").dataset.rows ?? "[]")).toMatchObject([
    { model: "opencode/kimi-k3" },
    { model: "opencode-go/kimi-k3" },
  ]);
  expect(screen.getByTestId("tooltip")).toHaveTextContent("Kimi K3");
  expect(screen.getByTestId("tooltip")).toHaveTextContent("opencode/kimi-k3");
});

it("shows the highest-cost model first without changing the server's entry order", () => {
  const entries = [
    { ...entry, key: "low", cost: 1 },
    { ...entry, key: "high", displayName: "High", cost: 20 },
  ];
  render(<AnalyticsModelBarChart entries={entries} loading={false} />);

  expect(JSON.parse(screen.getByTestId("chart").dataset.rows ?? "[]")).toMatchObject([
    { model: "High", cost: 20 },
    { model: "Sonnet", cost: 1 },
  ]);
  expect(entries.map(({ key }) => key)).toEqual(["low", "high"]);
});

it("shows an empty state and a loading placeholder", () => {
  const { rerender } = render(<AnalyticsModelBarChart entries={[]} loading={false} />);
  expect(screen.getByText(/No model data found/)).toBeInTheDocument();

  rerender(<AnalyticsModelBarChart loading />);
  expect(screen.queryByText(/No model data found/)).not.toBeInTheDocument();
});
