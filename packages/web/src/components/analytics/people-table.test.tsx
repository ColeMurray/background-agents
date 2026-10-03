// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, describe, expect, it } from "vitest";
import { analyticsDashboard, breakdownEntry } from "@/lib/analytics.test-fixture";
import { AnalyticsPeopleTable } from "./people-table";

expect.extend(matchers);
afterEach(cleanup);

function firstCells() {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);
}

describe("AnalyticsPeopleTable", () => {
  it("sorts by sessions and re-sorts when a header is clicked", async () => {
    const user = userEvent.setup();
    render(<AnalyticsPeopleTable dashboard={analyticsDashboard()} />);

    expect(firstCells()).toEqual(["AAnna", "ZZoe", "UUnknown userSessions without linked user"]);

    await user.click(screen.getByRole("button", { name: "User" }));
    expect(firstCells()[0]).toBe("AAnna");
    expect(firstCells()[1]).toBe("UUnknown userSessions without linked user");

    await user.click(screen.getByRole("button", { name: "Cost" }));
    expect(firstCells()[0]).toBe("ZZoe");
  });

  it("shows display names rather than user keys, and completion over finished sessions", () => {
    render(
      <AnalyticsPeopleTable
        dashboard={analyticsDashboard({
          breakdowns: {
            ...analyticsDashboard().breakdowns,
            user: {
              entries: [
                breakdownEntry("user-abc-123", {
                  displayName: "Alice Smith",
                  completed: 1,
                  failed: 8,
                  cancelled: 1,
                }),
              ],
            },
          },
        })}
      />
    );
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByText("Alice Smith")).toBeInTheDocument();
    expect(screen.queryByText("user-abc-123")).not.toBeInTheDocument();
    expect(row).toHaveTextContent("10%");
  });

  it("draws each person's daily sessions from their user key", () => {
    const { container } = render(<AnalyticsPeopleTable dashboard={analyticsDashboard()} />);
    const sparklines = container.querySelectorAll("tbody svg");
    // Anna, Zoe and the unknown user each have activity in the window.
    expect(sparklines).toHaveLength(3);
  });

  it("gives people who share a display name their own daily sessions", () => {
    const dashboard = analyticsDashboard();
    const { container } = render(
      <AnalyticsPeopleTable
        dashboard={{
          ...dashboard,
          timeseries: {
            series: [
              { date: "2026-09-21", groups: { "user-1": 3, "user-2": 1 } },
              { date: "2026-09-22", groups: { "user-1": 1, "user-2": 3 } },
            ],
          },
          breakdowns: {
            ...dashboard.breakdowns,
            user: {
              entries: [
                breakdownEntry("user-1", { displayName: "Alex", sessions: 4 }),
                breakdownEntry("user-2", { displayName: "Alex", sessions: 3 }),
              ],
            },
          },
        }}
      />
    );
    const lines = [...container.querySelectorAll("tbody svg path:last-child")].map((path) =>
      path.getAttribute("d")
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).not.toBe(lines[1]);
  });

  it("shows a dash for people with no finished sessions and sorts them below 0%", async () => {
    const user = userEvent.setup();
    const dashboard = analyticsDashboard();
    render(
      <AnalyticsPeopleTable
        dashboard={{
          ...dashboard,
          breakdowns: {
            ...dashboard.breakdowns,
            user: {
              entries: [
                breakdownEntry("running", {
                  displayName: "Running",
                  completed: 0,
                  failed: 0,
                  cancelled: 0,
                }),
                breakdownEntry("failing", {
                  displayName: "Failing",
                  completed: 0,
                  failed: 2,
                  cancelled: 0,
                }),
              ],
            },
          },
        }}
      />
    );
    expect(screen.getByRole("row", { name: /Running/ })).toHaveTextContent("—");
    await user.click(screen.getByRole("button", { name: "Completion" }));
    expect(firstCells()).toEqual(["FFailing", "RRunning"]);
  });

  it("shows an empty message when nobody is attributed", () => {
    render(
      <AnalyticsPeopleTable
        dashboard={analyticsDashboard({
          breakdowns: { ...analyticsDashboard().breakdowns, user: { entries: [] } },
        })}
      />
    );
    expect(screen.getByText("No user analytics found for this range.")).toBeInTheDocument();
  });
});
