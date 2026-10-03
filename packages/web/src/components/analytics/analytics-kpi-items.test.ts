import { describe, expect, it } from "vitest";
import { analyticsDashboard, breakdownEntry } from "@/lib/analytics.test-fixture";
import { getCostKpis, getHeadlineKpiGroups, getPullRequestKpis } from "./analytics-kpi-items";

describe("getHeadlineKpiGroups", () => {
  it("captions session numbers with the scope and pull request numbers with every source", () => {
    const groups = getHeadlineKpiGroups(analyticsDashboard());
    expect(groups.map((group) => group.caption)).toEqual([
      "Human sessions",
      "Pull requests · every source",
    ]);
    expect(
      getHeadlineKpiGroups(
        analyticsDashboard({ window: { ...analyticsDashboard().window, scope: "automation" } })
      )[0].caption
    ).toBe("Automation sessions");
  });

  it("leaves the PR funnel as the only source of PR counts", () => {
    // summary.totalPrs counts PRs from sessions in scope; showing it beside the
    // every-source funnel would put two different "PRs" numbers side by side.
    const values = getHeadlineKpiGroups(analyticsDashboard()).flatMap((group) =>
      group.items.flatMap((item) => [item.value, String(item.detail)])
    );
    expect(values.join(" ")).not.toContain("99");
  });

  it("summarizes sessions, spend and completion with a daily trend", () => {
    const [sessions] = getHeadlineKpiGroups(analyticsDashboard());
    expect(sessions.items.map((item) => [item.label, item.value])).toEqual([
      ["Sessions", "12"],
      ["Active users", "3"],
      ["Spend", "$12.50"],
      ["Completion rate", "70%"],
    ]);
    expect(sessions.items[0].trend).toHaveLength(8);
    expect(sessions.items[3].detail).toBe("2 failed · 1 cancelled");
  });

  it("counts merges during the window, the same population as its sparkline and merge time", () => {
    const dashboard = analyticsDashboard();
    const [, pullRequests] = getHeadlineKpiGroups(dashboard);
    const merged = pullRequests.items[0];
    expect(merged).toMatchObject({ label: "PRs merged", value: "5", detail: "Avg 30h to merge" });
    expect(merged.trend?.reduce((sum, count) => sum + count, 0)).toBe(
      dashboard.pullRequests.mergedInWindow
    );
    expect(pullRequests.items[1]).toMatchObject({
      label: "Cost per merged PR",
      value: "$1.50",
      detail: "PRs opened in range",
    });
  });

  it("divides attributed sessions by attributed people", () => {
    const dashboard = analyticsDashboard();
    const [sessions] = getHeadlineKpiGroups({
      ...dashboard,
      summary: { ...dashboard.summary, totalSessions: 103, activeUsers: 1 },
      breakdowns: {
        ...dashboard.breakdowns,
        user: {
          entries: [
            breakdownEntry("user-zoe", { displayName: "Zoe", sessions: 3 }),
            breakdownEntry("__unknown__", { displayName: "Unknown user", sessions: 100 }),
          ],
        },
      },
    });
    expect(sessions.items[1].detail).toBe("3 sessions per person");
  });

  it("shows no completion rate before any session finishes", () => {
    const dashboard = analyticsDashboard();
    const completion = getHeadlineKpiGroups({
      ...dashboard,
      summary: {
        ...dashboard.summary,
        statusBreakdown: {
          ...dashboard.summary.statusBreakdown,
          completed: 0,
          failed: 0,
          cancelled: 0,
        },
      },
    })[0].items[3];
    expect(completion.value).toBe("—");
    expect(completion.ratio).toBeNull();
  });
});

describe("getCostKpis", () => {
  it("adds private-session spend only for viewers who receive it", () => {
    expect(getCostKpis(analyticsDashboard()).map((item) => item.label)).not.toContain(
      "Private sessions"
    );
    const dashboard = analyticsDashboard();
    const items = getCostKpis({
      ...dashboard,
      summary: { ...dashboard.summary, privateSessionsCostUsd: 17.76 },
    });
    expect(items.at(-1)).toMatchObject({ label: "Private sessions", value: "$17.76" });
  });

  it("reports the subscription share and token totals", () => {
    const items = getCostKpis(analyticsDashboard());
    expect(items.find((item) => item.label === "Billed to subscriptions")?.value).toBe("33%");
    expect(items.find((item) => item.label === "Tokens")?.value).toBe("19.1K");
  });
});

describe("getPullRequestKpis", () => {
  it("describes the funnel, merge time and open inventory", () => {
    expect(
      getPullRequestKpis(analyticsDashboard()).map((item) => [item.label, item.value])
    ).toEqual([
      ["Opened", "10"],
      ["Acceptance rate", "86%"],
      ["Avg time to merge", "30h"],
      ["Open now", "3"],
      ["Cost per merged PR", "$1.50"],
    ]);
  });
});
