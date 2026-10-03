// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import type { AnalyticsSessionOriginEntry } from "@open-inspect/shared/types/analytics";
import { AnalyticsSessionSources } from "./session-sources";

expect.extend(matchers);
afterEach(cleanup);

const entries: AnalyticsSessionOriginEntry[] = [
  { source: "slack-bot", userKey: "alice", displayName: "Alice", sessions: 6 },
  { source: "slack-bot", userKey: "bob", displayName: "Bob", sessions: 2 },
  { source: "github-bot", userKey: "alice", displayName: "Alice", sessions: 1 },
  { source: "user", userKey: "__unknown__", displayName: "Unknown user", sessions: 1 },
];

describe("AnalyticsSessionSources", () => {
  it("ranks sources and aggregates users across sources without losing unknown attribution", () => {
    render(<AnalyticsSessionSources entries={entries} />);

    const slack = screen.getByRole("button", { name: /Slack/ });
    expect(within(slack).getByText("8")).toBeInTheDocument();
    expect(within(slack).getByText("80%")).toBeInTheDocument();

    const list = screen.getByRole("list", { name: "Users for All sources" });
    expect(list).toHaveAttribute("tabindex", "0");
    const users = within(list).getAllByRole("listitem");
    expect(within(users[0]).getByText("Alice")).toBeInTheDocument();
    expect(within(users[0]).getByText("7")).toBeInTheDocument();
    expect(within(users[0]).getByText("70%")).toBeInTheDocument();
    expect(within(users[2]).getByText("No recorded user")).toBeInTheDocument();
  });

  it("filters attributed users by source, uses source totals for shares, and resets", async () => {
    const user = userEvent.setup();
    render(<AnalyticsSessionSources entries={entries} />);

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
      <AnalyticsSessionSources
        entries={[
          { source: "slack-bot", userKey: "user-a", displayName: "Alex", sessions: 2 },
          { source: "slack-bot", userKey: "user-b", displayName: "Alex", sessions: 1 },
        ]}
      />
    );
    expect(screen.getAllByText("Alex")).toHaveLength(2);
    expect(screen.getByText("user-a")).toBeInTheDocument();
    expect(screen.getByText("user-b")).toBeInTheDocument();
  });

  it("points every source control at its own users list", () => {
    render(
      <>
        <AnalyticsSessionSources entries={entries} />
        <AnalyticsSessionSources entries={entries} />
      </>
    );
    const lists = screen.getAllByRole("list", { name: "Users for All sources" });
    const panelIds = lists.map((list) => list.parentElement!.id);
    expect(new Set(panelIds).size).toBe(2);
    const controlled = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-controls"));
    expect(new Set(controlled)).toEqual(new Set(panelIds));
  });

  it("falls back to all sources when refreshed data no longer contains the selection", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<AnalyticsSessionSources entries={entries} />);
    await user.click(screen.getByRole("button", { name: /Slack/ }));

    rerender(
      <AnalyticsSessionSources entries={entries.filter((entry) => entry.source === "github-bot")} />
    );
    expect(screen.getByRole("status")).toHaveTextContent("All sources: 1 sessions");

    rerender(<AnalyticsSessionSources entries={entries} />);
    expect(screen.getByRole("status")).toHaveTextContent("All sources: 10 sessions");
    expect(screen.getByRole("button", { name: "All sources" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });

  it("shows an empty state without controls", () => {
    render(<AnalyticsSessionSources entries={[]} />);
    expect(screen.getByText("No sessions found for this range and scope.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
