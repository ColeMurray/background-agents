// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { AnalyticsSessionOriginEntry } from "@open-inspect/shared/types/analytics";
import { AnalyticsSessionOriginsCard } from "./session-origins-card";

expect.extend(matchers);
afterEach(cleanup);

const entries: AnalyticsSessionOriginEntry[] = [
  { source: "slack-bot", userKey: "alice", displayName: "Alice", sessions: 6 },
  { source: "slack-bot", userKey: "bob", displayName: "Bob", sessions: 2 },
  { source: "github-bot", userKey: "alice", displayName: "Alice", sessions: 1 },
  { source: "user", userKey: "__unknown__", displayName: "Unknown user", sessions: 1 },
];

describe("AnalyticsSessionOriginsCard", () => {
  it("ranks sources and aggregates users across sources without losing unknown attribution", () => {
    render(<AnalyticsSessionOriginsCard entries={entries} loading={false} />);
    const slack = screen.getByRole("button", { name: /Slack/ });
    expect(within(slack).getByText("8")).toBeInTheDocument();
    expect(within(slack).getByText("80%")).toBeInTheDocument();
    const users = within(screen.getByRole("list", { name: "Users for All sources" })).getAllByRole(
      "listitem"
    );
    expect(within(users[0]).getByText("Alice")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Users for All sources" })).toHaveAttribute(
      "tabindex",
      "0"
    );
    expect(within(users[0]).getByText("7")).toBeInTheDocument();
    expect(within(users[0]).getByText("70%")).toBeInTheDocument();
    expect(within(users[2]).getByText("No recorded user")).toBeInTheDocument();
  });

  it("filters attributed users by source, uses source totals for shares, and resets", async () => {
    const user = userEvent.setup();
    render(<AnalyticsSessionOriginsCard entries={entries} loading={false} />);
    await user.click(screen.getByRole("button", { name: /Slack/ }));
    expect(screen.getByRole("button", { name: /Slack/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Slack: 8 sessions");
    const users = within(screen.getByRole("list", { name: "Users for Slack" }));
    expect(users.getByText("75%")).toBeInTheDocument();
    expect(users.queryByText("Unknown user")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "All sources" }));
    expect(screen.getByRole("status")).toHaveTextContent("All sources: 10 sessions");
    await user.click(screen.getByRole("button", { name: /GitHub/ }));
    await user.click(screen.getByRole("button", { name: /GitHub/ }));
    expect(screen.getByRole("button", { name: "All sources" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("keeps equal display names separate and shows their identity keys", () => {
    render(
      <AnalyticsSessionOriginsCard
        entries={[
          { source: "slack-bot", userKey: "user-a", displayName: "Alex", sessions: 2 },
          { source: "slack-bot", userKey: "user-b", displayName: "Alex", sessions: 1 },
        ]}
        loading={false}
      />
    );
    expect(screen.getAllByText("Alex")).toHaveLength(2);
    expect(screen.getByText("user-a")).toBeInTheDocument();
    expect(screen.getByText("user-b")).toBeInTheDocument();
  });

  it("shows loading and empty states and retains cached data during refresh", () => {
    const { rerender } = render(<AnalyticsSessionOriginsCard loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading session origins");
    rerender(<AnalyticsSessionOriginsCard entries={[]} loading={false} />);
    expect(screen.getByText("No sessions found for this range and scope.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    rerender(<AnalyticsSessionOriginsCard entries={entries} loading />);
    expect(screen.getByRole("button", { name: /Slack/ })).toBeInTheDocument();
  });

  it("falls back to all sources when refreshed data no longer contains the selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AnalyticsSessionOriginsCard entries={entries} loading={false} />);
    await user.click(screen.getByRole("button", { name: /Slack/ }));
    rerender(
      <AnalyticsSessionOriginsCard
        entries={entries.filter((entry) => entry.source === "github-bot")}
        loading={false}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("All sources: 1 sessions");
    rerender(<AnalyticsSessionOriginsCard entries={entries} loading={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("All sources: 10 sessions");
    expect(screen.getByRole("button", { name: "All sources" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
