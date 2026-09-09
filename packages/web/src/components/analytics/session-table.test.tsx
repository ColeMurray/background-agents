// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />
import * as matchers from "@testing-library/jest-dom/matchers";
import { render, screen, fireEvent, within, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsSessionTable } from "./session-table";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";

expect.extend(matchers);
afterEach(cleanup);

const entry = (key: string, totalTokens: number | null): AnalyticsBreakdownEntry => ({
  key,
  displayName: key,
  user: "Alice",
  repository: "group/repo",
  status: "completed",
  sessions: 1,
  completed: 1,
  failed: 0,
  cancelled: 0,
  cost: 0,
  totalTokens,
  prs: 0,
  messageCount: 2,
  avgDuration: 5000,
  lastActive: Date.now(),
});

describe("AnalyticsSessionTable", () => {
  it("shows tokens for zero-cost threads, distinguishes missing usage, and links to the thread", () => {
    render(
      <AnalyticsSessionTable
        entries={[entry("known", 12000), entry("unknown", null)]}
        loading={false}
      />
    );
    expect(screen.getByText("12,000")).toBeInTheDocument();
    expect(screen.getByText("Not reported")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "known" })).toHaveAttribute("href", "/session/known");
    fireEvent.click(screen.getByRole("button", { name: "Tokens" }));
    expect(within(screen.getAllByRole("row")[1]).getByRole("link")).toHaveTextContent("known");
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "unknown" },
    });
    expect(screen.queryByRole("link", { name: "known" })).not.toBeInTheDocument();
  });

  it("pages through every session", () => {
    render(
      <AnalyticsSessionTable
        entries={Array.from({ length: 26 }, (_, index) => entry(`session-${index}`, index))}
        loading={false}
      />
    );
    expect(screen.getAllByRole("link")).toHaveLength(25);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("shows loading and empty states", () => {
    const { rerender } = render(<AnalyticsSessionTable loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading session usage");
    rerender(<AnalyticsSessionTable entries={[]} loading={false} />);
    expect(screen.getByText("No sessions found for this range.")).toBeInTheDocument();
  });
});
