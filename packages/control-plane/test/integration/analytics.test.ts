import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import type {
  AnalyticsBreakdownResponse,
  AnalyticsDashboardResponse,
  AnalyticsSummaryResponse,
  AnalyticsTokenTotals,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared/types/analytics";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import type { HarnessId } from "@open-inspect/shared/harnesses";
import { SessionIndexStore } from "../../src/db/session-index";
import { TeamMembershipStore } from "../../src/db/team-memberships";
import { SessionRunStore } from "../../src/db/session-run-store";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceFetch, serviceRequestHeaders } from "./helpers";

const zeroTokens: AnalyticsTokenTotals = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function dateBucket(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function seedSession(
  store: SessionIndexStore,
  input: {
    id: string;
    repoOwner: string | null;
    repoName: string | null;
    baseBranch?: string | null;
    scmLogin: string | null;
    userId?: string | null;
    ownerTeamId?: string | null;
    visibility?: "workspace" | "team" | "private";
    parentSessionId?: string;
    spawnSource?: SpawnSource;
    harness?: HarnessId;
    automationId?: string;
    model?: string;
    status: "created" | "active" | "completed" | "failed" | "archived" | "cancelled";
    createdAt: number;
    updatedAt: number;
    totalCost: number;
    activeDurationMs: number;
    messageCount: number;
    prCount: number;
    tokens?: AnalyticsTokenTotals;
  }
): Promise<void> {
  await store.create({
    id: input.id,
    ownerTeamId: input.ownerTeamId ?? null,
    visibility: input.visibility ?? "workspace",
    title: input.id,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    model: input.model ?? "anthropic/claude-haiku-4-5",
    harness: input.harness,
    automationId: input.automationId,
    reasoningEffort: null,
    baseBranch:
      input.repoOwner !== null && input.repoName !== null ? (input.baseBranch ?? "main") : null,
    status: input.status,
    spawnSource: input.spawnSource,
    scmLogin: input.scmLogin,
    userId: input.userId,
    parentSessionId: input.parentSessionId,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });

  await store.updateMetrics(input.id, {
    totalCost: input.totalCost,
    activeDurationMs: input.activeDurationMs,
    messageCount: input.messageCount,
    prCount: input.prCount,
    inputTokens: input.tokens?.inputTokens ?? 0,
    outputTokens: input.tokens?.outputTokens ?? 0,
    reasoningTokens: input.tokens?.reasoningTokens ?? 0,
    cacheReadTokens: input.tokens?.cacheReadTokens ?? 0,
    cacheWriteTokens: input.tokens?.cacheWriteTokens ?? 0,
  });
}

async function seedUser(
  db: D1Database,
  user: { id: string; displayName: string; email?: string }
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)"
    )
    .bind(user.id, user.displayName, user.email ?? null, now, now)
    .run();
}

describe("Analytics API", () => {
  beforeEach(cleanD1Tables);

  it("limits every dashboard population to visible non-private sessions while reconciling all private cost", async () => {
    const member = "22222222222222222222222222222222";
    const now = Date.now() - 60_000;
    await serviceRequestHeaders("https://test.local/analytics/dashboard", {
      as: { userId: member, role: "member" },
    });
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('analytics-allowed', 'analytics-allowed', 'Allowed', 1, 1), ('analytics-denied', 'analytics-denied', 'Denied', 1, 1)"
    ).run();
    await new TeamMembershipStore(env.DB).add("analytics-allowed", member);
    const store = new SessionIndexStore(env.DB);
    for (const [id, teamId, visibility, cost, parentSessionId] of [
      ["visible-root", null, "workspace", 1, undefined],
      ["visible-child", "analytics-allowed", "team", 2, "visible-root"],
      ["hidden-child", "analytics-denied", "team", 4, "visible-root"],
      ["private-child", null, "private", 8, "visible-root"],
      ["owner-private", null, "private", 16, undefined],
    ] as const) {
      await seedSession(store, {
        id,
        repoOwner: "acme",
        repoName: "app",
        scmLogin: id,
        userId: member,
        ownerTeamId: teamId,
        visibility,
        parentSessionId,
        spawnSource: id === "owner-private" ? "agent" : "user",
        status: "completed",
        createdAt: now,
        updatedAt: now + 10,
        totalCost: cost,
        activeDurationMs: 10,
        messageCount: 1,
        prCount: 1,
        tokens: {
          inputTokens: cost,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
    }
    const fetchAnalytics = async (path: string, mode: "on" | "off") => {
      const url = `https://test.local/analytics/${path}`;
      return routeRequest(
        new Request(url, {
          headers: await serviceRequestHeaders(url, { as: { userId: member, role: "member" } }),
        }),
        { ...env, TEAMS_ENFORCEMENT: mode },
        createExecutionContext()
      );
    };

    const dashboardResponse = await fetchAnalytics("dashboard?scope=all", "on");
    expect(dashboardResponse.status).toBe(200);
    const dashboard = await dashboardResponse.json<AnalyticsDashboardResponse>();
    expect(dashboard.summary).toMatchObject({
      totalSessions: 2,
      totalCost: 3,
      inputTokens: 3,
      privateSessionsCostUsd: 24,
    });
    expect(
      dashboard.timeseries.series
        .flatMap((point) => Object.values(point.groups))
        .reduce((a, b) => a + b, 0)
    ).toBe(2);
    for (const dimension of ["repository", "user", "model", "harness", "provider"] as const) {
      expect(
        dashboard.breakdowns[dimension].entries.reduce((sum, entry) => sum + entry.cost, 0)
      ).toBe(3);
    }
    expect(dashboard.runs).toEqual([
      expect.objectContaining({ rootSessionId: "visible-root", sessionCount: 2, totalCost: 3 }),
    ]);
    expect(
      await new SessionRunStore(env.DB, { kind: "service", teamId: null }).get("owner-private")
    ).toBeNull();
    expect(
      (await (await fetchAnalytics("runs", "on")).json<{ runs: { totalCost: number }[] }>()).runs[0]
        .totalCost
    ).toBe(3);
    expect(
      await (await fetchAnalytics("summary?scope=human", "on")).json<AnalyticsSummaryResponse>()
    ).toMatchObject({ totalSessions: 2, totalCost: 3, privateSessionsCostUsd: 24 });
    expect(
      await (await fetchAnalytics("summary?scope=all", "off")).json<AnalyticsSummaryResponse>()
    ).toMatchObject({ totalSessions: 3, totalCost: 7, privateSessionsCostUsd: 24 });
  });

  it("sums token totals across sessions and provider merges without excluding zero-token history", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - 60_000;
    for (const [id, model, tokens] of [
      [
        "gpt-5",
        "openai/gpt-5",
        {
          inputTokens: 2,
          outputTokens: 5,
          reasoningTokens: 1,
          cacheReadTokens: 6,
          cacheWriteTokens: 3,
        },
      ],
      [
        "gpt-5.3",
        "openai/gpt-5.3-codex",
        {
          inputTokens: 1,
          outputTokens: 4,
          reasoningTokens: 2,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
      ],
      ["old", "openai/gpt-5", undefined],
    ] as const) {
      await seedSession(store, {
        id,
        model,
        tokens,
        repoOwner: "acme",
        repoName: "app",
        scmLogin: "alice",
        status: "completed",
        createdAt: now,
        updatedAt: now + 100,
        totalCost: 1,
        activeDurationMs: 100,
        messageCount: 1,
        prCount: 0,
      });
    }
    const dashboard = await (
      await serviceFetch("https://test.local/analytics/dashboard?scope=all")
    ).json<AnalyticsDashboardResponse>();
    const totals = {
      inputTokens: 3,
      outputTokens: 9,
      reasoningTokens: 3,
      cacheReadTokens: 9,
      cacheWriteTokens: 5,
    };
    expect(dashboard.summary).toMatchObject({ totalSessions: 3, ...totals, cacheHitRatio: 0.75 });
    expect(dashboard.breakdowns.repository.entries[0]).toMatchObject(totals);
    expect(dashboard.breakdowns.user.entries[0]).toMatchObject(totals);
    expect(dashboard.breakdowns.model.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "openai/gpt-5", inputTokens: 2, cacheReadTokens: 6 }),
        expect.objectContaining({
          key: "openai/gpt-5.3-codex",
          inputTokens: 1,
          cacheReadTokens: 3,
        }),
      ])
    );
    expect(dashboard.breakdowns.provider.entries[0]).toMatchObject({ key: "openai", ...totals });
    expect(dashboard.summary.cacheHitRatio).toBe(9 / (9 + 3));
    expect(dashboard.runs).toHaveLength(3);
  });

  it("lists only scoped top-cost runs in the dashboard, capped at the dashboard limit", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - 60_000;
    for (let i = 0; i < 21; i++) {
      await seedSession(store, {
        id: `root-${i}`,
        repoOwner: "acme",
        repoName: "app",
        scmLogin: null,
        spawnSource: i === 20 ? "automation" : "user",
        status: "completed",
        createdAt: now,
        updatedAt: now + i,
        totalCost: i + 1,
        activeDurationMs: 0,
        messageCount: 0,
        prCount: 0,
      });
    }
    await env.DB.prepare("UPDATE sessions SET title = NULL WHERE id = 'root-19'").run();
    const human = await (
      await serviceFetch("https://test.local/analytics/dashboard?scope=human")
    ).json<AnalyticsDashboardResponse>();
    expect(human.runs).toHaveLength(20);
    expect(human.runs.map((run) => run.totalCost)).toEqual(
      Array.from({ length: 20 }, (_, i) => 20 - i)
    );
    expect(human.runs[0]).toMatchObject({ rootSessionId: "root-19", title: null });
    const all = await (
      await serviceFetch("https://test.local/analytics/dashboard?scope=all")
    ).json<AnalyticsDashboardResponse>();
    expect(all.runs).toHaveLength(20);
    expect(all.runs[0].rootSessionId).toBe("root-20");
    expect(all.runs.at(-1)?.rootSessionId).toBe("root-1");
  });

  it("returns one coherently-windowed dashboard snapshot", async () => {
    const before = Date.now();
    const response = await serviceFetch("https://test.local/analytics/dashboard?days=7");
    const after = Date.now();

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsDashboardResponse>();
    expect(body.generatedAt).toBeGreaterThanOrEqual(before);
    expect(body.generatedAt).toBeLessThanOrEqual(after);
    expect(body.window).toEqual({
      days: 7,
      startAt: body.generatedAt - 7 * 24 * 60 * 60 * 1000,
      endAt: body.generatedAt,
      scope: "human",
    });
    expect(body).toMatchObject({
      summary: { totalSessions: 0, totalPrs: 0 },
      timeseries: { series: [] },
      breakdowns: {
        repository: { entries: [] },
        user: { entries: [] },
        model: { entries: [] },
        harness: { entries: [] },
        provider: { entries: [] },
        automation: { entries: [] },
      },
      pullRequests: {
        funnel: { created: 0, open: 0, draft: 0, merged: 0, closed: 0 },
        timeseries: [],
        repos: [],
        sources: [],
      },
    });
  });

  it("returns summary metrics for the requested window", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    await seedSession(store, {
      id: "session-completed",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "completed",
      createdAt: now - 2 * 24 * 60 * 60 * 1000,
      updatedAt: now - 2 * 24 * 60 * 60 * 1000 + 1_000,
      totalCost: 1.5,
      activeDurationMs: 600_000,
      messageCount: 10,
      prCount: 1,
    });
    await seedSession(store, {
      id: "session-failed",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: "bob",
      status: "failed",
      createdAt: now - 2 * 24 * 60 * 60 * 1000 + 60_000,
      updatedAt: now - 2 * 24 * 60 * 60 * 1000 + 2_000,
      totalCost: 0.5,
      activeDurationMs: 300_000,
      messageCount: 4,
      prCount: 0,
    });
    await seedSession(store, {
      id: "session-cancelled",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "cancelled",
      createdAt: now - 24 * 60 * 60 * 1000,
      updatedAt: now - 24 * 60 * 60 * 1000 + 3_000,
      totalCost: 0.75,
      activeDurationMs: 120_000,
      messageCount: 6,
      prCount: 1,
    });
    await seedSession(store, {
      id: "session-active",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: null,
      status: "active",
      createdAt: now - 24 * 60 * 60 * 1000 + 60_000,
      updatedAt: now - 24 * 60 * 60 * 1000 + 4_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });
    await seedSession(store, {
      id: "session-created",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "charlie",
      status: "created",
      createdAt: now - 5 * 24 * 60 * 60 * 1000,
      updatedAt: now - 5 * 24 * 60 * 60 * 1000 + 5_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });
    await seedSession(store, {
      id: "session-archived",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: "bob",
      status: "archived",
      createdAt: now - 3 * 24 * 60 * 60 * 1000,
      updatedAt: now - 3 * 24 * 60 * 60 * 1000 + 6_000,
      totalCost: 0.25,
      activeDurationMs: 50_000,
      messageCount: 1,
      prCount: 0,
    });
    await seedSession(store, {
      id: "session-old",
      repoOwner: "acme",
      repoName: "legacy",
      scmLogin: "dora",
      status: "completed",
      createdAt: now - 45 * 24 * 60 * 60 * 1000,
      updatedAt: now - 45 * 24 * 60 * 60 * 1000 + 7_000,
      totalCost: 9.99,
      activeDurationMs: 999_000,
      messageCount: 99,
      prCount: 9,
    });

    const response = await serviceFetch("https://test.local/analytics/summary?days=30");

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsSummaryResponse>();

    expect(body).toEqual({
      totalSessions: 6,
      ...zeroTokens,
      cacheHitRatio: null,
      activeUsers: 3,
      totalCost: 3,
      privateSessionsCostUsd: 0,
      avgCost: 0.5,
      totalPrs: 2,
      statusBreakdown: {
        created: 1,
        active: 1,
        completed: 1,
        failed: 1,
        archived: 1,
        cancelled: 1,
      },
    });
  });

  it("returns daily timeseries grouped by user", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = new Date().setUTCHours(12, 0, 0, 0);

    const completedAt = now - 2 * 24 * 60 * 60 * 1000;
    const failedAt = completedAt + 60_000;
    const cancelledAt = now - 24 * 60 * 60 * 1000;
    const activeAt = cancelledAt + 60_000;

    await seedSession(store, {
      id: "user-day-a",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "completed",
      createdAt: completedAt,
      updatedAt: completedAt + 1_000,
      totalCost: 1,
      activeDurationMs: 100_000,
      messageCount: 1,
      prCount: 0,
    });
    await seedSession(store, {
      id: "user-day-b",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: "bob",
      status: "failed",
      createdAt: failedAt,
      updatedAt: failedAt + 1_000,
      totalCost: 1,
      activeDurationMs: 100_000,
      messageCount: 1,
      prCount: 0,
    });
    await seedSession(store, {
      id: "user-day-c",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "cancelled",
      createdAt: cancelledAt,
      updatedAt: cancelledAt + 1_000,
      totalCost: 1,
      activeDurationMs: 100_000,
      messageCount: 1,
      prCount: 0,
    });
    await seedSession(store, {
      id: "user-day-d",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: null,
      status: "active",
      createdAt: activeAt,
      updatedAt: activeAt + 1_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });

    const response = await serviceFetch("https://test.local/analytics/timeseries?days=7");

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsTimeseriesResponse>();

    expect(body.series).toEqual([
      {
        date: dateBucket(completedAt),
        groups: {
          alice: 1,
          bob: 1,
        },
      },
      {
        date: dateBucket(cancelledAt),
        groups: {
          alice: 1,
          __unknown__: 1,
        },
      },
    ]);
  });

  it("returns user breakdowns with unknown users grouped together", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    const aliceCompletedAt = now - 2 * 24 * 60 * 60 * 1000;
    const aliceCreatedAt = now - 24 * 60 * 60 * 1000;
    const bobFailedAt = now - 3 * 24 * 60 * 60 * 1000;
    const unknownActiveAt = now - 4 * 24 * 60 * 60 * 1000;

    await seedSession(store, {
      id: "user-breakdown-alice-completed",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "completed",
      createdAt: aliceCompletedAt,
      updatedAt: aliceCompletedAt + 1_000,
      totalCost: 1.25,
      activeDurationMs: 100_000,
      messageCount: 3,
      prCount: 1,
    });
    await seedSession(store, {
      id: "user-breakdown-alice-created",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: "alice",
      status: "created",
      createdAt: aliceCreatedAt,
      updatedAt: aliceCreatedAt + 2_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });
    await seedSession(store, {
      id: "user-breakdown-bob-failed",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: "bob",
      status: "failed",
      createdAt: bobFailedAt,
      updatedAt: bobFailedAt + 3_000,
      totalCost: 0.75,
      activeDurationMs: 50_000,
      messageCount: 2,
      prCount: 0,
    });
    await seedSession(store, {
      id: "user-breakdown-unknown-active",
      repoOwner: "acme",
      repoName: "ops",
      scmLogin: null,
      status: "active",
      createdAt: unknownActiveAt,
      updatedAt: unknownActiveAt + 4_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });

    const response = await serviceFetch("https://test.local/analytics/breakdown?days=30&by=user");

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsBreakdownResponse>();

    expect(body.entries).toEqual([
      {
        key: "alice",
        displayName: "alice",
        ...zeroTokens,
        sessions: 2,
        completed: 1,
        failed: 0,
        cancelled: 0,
        cost: 1.25,
        prs: 1,
        messageCount: 3,
        avgDuration: 100_000,
        lastActive: aliceCreatedAt + 2_000,
      },
      {
        key: "__unknown__",
        displayName: "Unknown user",
        ...zeroTokens,
        sessions: 1,
        completed: 0,
        failed: 0,
        cancelled: 0,
        cost: 0,
        prs: 0,
        messageCount: 0,
        avgDuration: 0,
        lastActive: unknownActiveAt + 4_000,
      },
      {
        key: "bob",
        displayName: "bob",
        ...zeroTokens,
        sessions: 1,
        completed: 0,
        failed: 1,
        cancelled: 0,
        cost: 0.75,
        prs: 0,
        messageCount: 2,
        avgDuration: 50_000,
        lastActive: bobFailedAt + 3_000,
      },
    ]);
  });

  it("returns repository breakdown with terminal-only avg durations", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    const webCreatedAt = now - 2 * 24 * 60 * 60 * 1000;
    const webCancelledAt = now - 24 * 60 * 60 * 1000;
    const webPendingAt = now - 12 * 60 * 60 * 1000;
    const apiFailedAt = now - 3 * 24 * 60 * 60 * 1000;
    const apiActiveAt = now - 6 * 60 * 60 * 1000;
    const noRepoCompletedAt = now - 5 * 60 * 60 * 1000;

    await seedSession(store, {
      id: "repo-web-completed",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "completed",
      createdAt: webCreatedAt,
      updatedAt: webCreatedAt + 5_000,
      totalCost: 1.5,
      activeDurationMs: 600_000,
      messageCount: 10,
      prCount: 1,
    });
    await seedSession(store, {
      id: "repo-web-cancelled",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "alice",
      status: "cancelled",
      createdAt: webCancelledAt,
      updatedAt: webCancelledAt + 6_000,
      totalCost: 0.75,
      activeDurationMs: 120_000,
      messageCount: 6,
      prCount: 1,
    });
    await seedSession(store, {
      id: "repo-web-created",
      repoOwner: "acme",
      repoName: "web-app",
      scmLogin: "charlie",
      status: "created",
      createdAt: webPendingAt,
      updatedAt: webPendingAt + 10_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });
    await seedSession(store, {
      id: "repo-api-failed",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: "bob",
      status: "failed",
      createdAt: apiFailedAt,
      updatedAt: apiFailedAt + 7_000,
      totalCost: 0.5,
      activeDurationMs: 300_000,
      messageCount: 4,
      prCount: 0,
    });
    await seedSession(store, {
      id: "repo-api-active",
      repoOwner: "acme",
      repoName: "api",
      scmLogin: null,
      status: "active",
      createdAt: apiActiveAt,
      updatedAt: apiActiveAt + 8_000,
      totalCost: 0,
      activeDurationMs: 0,
      messageCount: 0,
      prCount: 0,
    });
    await seedSession(store, {
      id: "no-repo-completed",
      repoOwner: null,
      repoName: null,
      scmLogin: "dana",
      status: "completed",
      createdAt: noRepoCompletedAt,
      updatedAt: noRepoCompletedAt + 9_000,
      totalCost: 0.25,
      activeDurationMs: 30_000,
      messageCount: 1,
      prCount: 0,
    });

    const response = await serviceFetch("https://test.local/analytics/breakdown?days=30&by=repo");

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsBreakdownResponse>();

    expect(body.entries).toEqual([
      {
        key: "acme/web-app",
        ...zeroTokens,
        sessions: 3,
        completed: 1,
        failed: 0,
        cancelled: 1,
        cost: 2.25,
        prs: 2,
        messageCount: 16,
        avgDuration: 360_000,
        lastActive: webPendingAt + 10_000,
      },
      {
        key: "acme/api",
        ...zeroTokens,
        sessions: 2,
        completed: 0,
        failed: 1,
        cancelled: 0,
        cost: 0.5,
        prs: 0,
        messageCount: 4,
        avgDuration: 300_000,
        lastActive: apiActiveAt + 8_000,
      },
      {
        key: "No repository",
        ...zeroTokens,
        sessions: 1,
        completed: 1,
        failed: 0,
        cancelled: 0,
        cost: 0.25,
        prs: 0,
        messageCount: 1,
        avgDuration: 30_000,
        lastActive: noRepoCompletedAt + 9_000,
      },
    ]);
  });

  it("includes bot-spawned sessions and excludes agent/automation sessions", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    const base = now - 2 * 24 * 60 * 60 * 1000;

    // Human-initiated sessions (should be included)
    await seedSession(store, {
      id: "web-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice",
      spawnSource: "user",
      status: "completed",
      createdAt: base,
      updatedAt: base + 1_000,
      totalCost: 1,
      activeDurationMs: 100_000,
      messageCount: 5,
      prCount: 1,
    });
    await seedSession(store, {
      id: "slack-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: null,
      spawnSource: "slack-bot",
      status: "completed",
      createdAt: base + 60_000,
      updatedAt: base + 61_000,
      totalCost: 0.5,
      activeDurationMs: 50_000,
      messageCount: 3,
      prCount: 0,
    });
    await seedSession(store, {
      id: "linear-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: null,
      spawnSource: "linear-bot",
      status: "failed",
      createdAt: base + 120_000,
      updatedAt: base + 121_000,
      totalCost: 0.25,
      activeDurationMs: 30_000,
      messageCount: 2,
      prCount: 0,
    });
    await seedSession(store, {
      id: "github-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "bob",
      spawnSource: "github-bot",
      status: "completed",
      createdAt: base + 180_000,
      updatedAt: base + 181_000,
      totalCost: 0.75,
      activeDurationMs: 80_000,
      messageCount: 4,
      prCount: 1,
    });

    // Non-human sessions (should be excluded)
    await seedSession(store, {
      id: "agent-child",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice",
      spawnSource: "agent",
      status: "completed",
      createdAt: base + 240_000,
      updatedAt: base + 241_000,
      totalCost: 2,
      activeDurationMs: 200_000,
      messageCount: 10,
      prCount: 0,
    });
    await seedSession(store, {
      id: "automation-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice",
      spawnSource: "automation",
      status: "completed",
      createdAt: base + 300_000,
      updatedAt: base + 301_000,
      totalCost: 3,
      activeDurationMs: 400_000,
      messageCount: 20,
      prCount: 2,
    });

    // Summary should count only the 4 human sessions
    const summaryRes = await serviceFetch("https://test.local/analytics/summary?days=7");
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json<AnalyticsSummaryResponse>();
    expect(summary.totalSessions).toBe(4);
    expect(summary.activeUsers).toBe(2); // alice + bob (scm_login-based)
    expect(summary.totalCost).toBe(2.5);
    expect(summary.totalPrs).toBe(2);

    // Breakdown by user should include bot sessions, not agent/automation
    const breakdownRes = await serviceFetch(
      "https://test.local/analytics/breakdown?days=7&by=user"
    );
    expect(breakdownRes.status).toBe(200);
    const breakdown = await breakdownRes.json<AnalyticsBreakdownResponse>();

    const keys = breakdown.entries.map((e) => e.key);
    expect(keys).toContain("alice");
    expect(keys).toContain("bob");
    expect(keys).toContain("__unknown__"); // slack + linear sessions with no scm_login

    const totalBreakdownSessions = breakdown.entries.reduce((n, e) => n + e.sessions, 0);
    expect(totalBreakdownSessions).toBe(4);
  });

  it("groups sessions by user_id and shows display name from users table", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();

    // Seed a user in the users table
    await seedUser(env.DB, {
      id: "user-abc",
      displayName: "Alice Smith",
      email: "alice@acme.test",
    });

    // Two sessions with the same user_id but different scm_logins → should merge
    await seedSession(store, {
      id: "alice-web",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice",
      userId: "user-abc",
      status: "completed",
      createdAt: now - 2 * 24 * 60 * 60 * 1000,
      updatedAt: now - 2 * 24 * 60 * 60 * 1000 + 1_000,
      totalCost: 1,
      activeDurationMs: 100_000,
      messageCount: 5,
      prCount: 1,
    });
    await seedSession(store, {
      id: "alice-github",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice-gh",
      userId: "user-abc",
      status: "completed",
      createdAt: now - 24 * 60 * 60 * 1000,
      updatedAt: now - 24 * 60 * 60 * 1000 + 2_000,
      totalCost: 0.5,
      activeDurationMs: 50_000,
      messageCount: 3,
      prCount: 0,
    });

    // Session without user_id falls back to scm_login key
    await seedSession(store, {
      id: "bob-unlinked",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "bob",
      status: "failed",
      createdAt: now - 3 * 24 * 60 * 60 * 1000,
      updatedAt: now - 3 * 24 * 60 * 60 * 1000 + 3_000,
      totalCost: 0.25,
      activeDurationMs: 30_000,
      messageCount: 2,
      prCount: 0,
    });

    // Breakdown: user_id sessions merge under canonical ID with display name
    const breakdownRes = await serviceFetch(
      "https://test.local/analytics/breakdown?days=30&by=user"
    );
    expect(breakdownRes.status).toBe(200);
    const breakdown = await breakdownRes.json<AnalyticsBreakdownResponse>();

    expect(breakdown.entries).toEqual([
      {
        key: "user-abc",
        displayName: "Alice Smith",
        ...zeroTokens,
        sessions: 2,
        completed: 2,
        failed: 0,
        cancelled: 0,
        cost: 1.5,
        prs: 1,
        messageCount: 8,
        avgDuration: 75_000,
        lastActive: now - 24 * 60 * 60 * 1000 + 2_000,
      },
      {
        key: "bob",
        displayName: "bob",
        ...zeroTokens,
        sessions: 1,
        completed: 0,
        failed: 1,
        cancelled: 0,
        cost: 0.25,
        prs: 0,
        messageCount: 2,
        avgDuration: 30_000,
        lastActive: now - 3 * 24 * 60 * 60 * 1000 + 3_000,
      },
    ]);

    // Summary: activeUsers counts distinct user_id (alice's 2 sessions = 1 user)
    const summaryRes = await serviceFetch("https://test.local/analytics/summary?days=30");
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json<AnalyticsSummaryResponse>();
    expect(summary.activeUsers).toBe(2); // user-abc + bob

    // Timeseries: uses display name from users table
    const timeseriesRes = await serviceFetch("https://test.local/analytics/timeseries?days=30");
    expect(timeseriesRes.status).toBe(200);
    const timeseries = await timeseriesRes.json<AnalyticsTimeseriesResponse>();

    // All Alice's sessions should appear under "Alice Smith", not "alice"/"alice-gh"
    const allGroups = timeseries.series.flatMap((s) => Object.keys(s.groups));
    expect(allGroups).toContain("Alice Smith");
    expect(allGroups).not.toContain("alice");
    expect(allGroups).not.toContain("alice-gh");
    expect(allGroups).toContain("bob");
  });

  it("sums timeseries counts when distinct users share the same display name", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = new Date().setUTCHours(12, 0, 0, 0);
    const dayAgo = now - 24 * 60 * 60 * 1000;

    // Two distinct users with the same display name
    await seedUser(env.DB, { id: "user-alex-1", displayName: "Alex" });
    await seedUser(env.DB, { id: "user-alex-2", displayName: "Alex" });

    await seedSession(store, {
      id: "alex1-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alex-one",
      userId: "user-alex-1",
      status: "completed",
      createdAt: dayAgo,
      updatedAt: dayAgo + 1_000,
      totalCost: 1,
      activeDurationMs: 100_000,
      messageCount: 5,
      prCount: 1,
    });
    await seedSession(store, {
      id: "alex2-session",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alex-two",
      userId: "user-alex-2",
      status: "completed",
      createdAt: dayAgo + 60_000,
      updatedAt: dayAgo + 61_000,
      totalCost: 0.5,
      activeDurationMs: 50_000,
      messageCount: 3,
      prCount: 0,
    });

    const res = await serviceFetch("https://test.local/analytics/timeseries?days=7");
    expect(res.status).toBe(200);
    const body = await res.json<AnalyticsTimeseriesResponse>();

    // Both sessions land on the same date with the same "Alex" label
    const dayBucket = dateBucket(dayAgo);
    const dayEntry = body.series.find((s) => s.date === dayBucket);
    expect(dayEntry).toBeDefined();
    // Reducer must sum, not overwrite: 1 + 1 = 2
    expect(dayEntry!.groups["Alex"]).toBe(2);
  });

  it("keeps the default dashboard population and existing resources identical to explicit human scope", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - 60_000;
    await seedSession(store, {
      id: "human",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice",
      spawnSource: "user",
      status: "completed",
      createdAt: now,
      updatedAt: now + 100,
      totalCost: 2,
      activeDurationMs: 100,
      messageCount: 3,
      prCount: 1,
    });
    await seedSession(store, {
      id: "agent",
      repoOwner: "acme",
      repoName: "app",
      scmLogin: "alice",
      spawnSource: "agent",
      status: "completed",
      createdAt: now,
      updatedAt: now + 100,
      totalCost: 5,
      activeDurationMs: 100,
      messageCount: 3,
      prCount: 1,
    });
    for (const path of ["summary", "timeseries", "breakdown?by=repo", "breakdown?by=user"]) {
      const separator = path.includes("?") ? "&" : "?";
      const ordinary = await serviceFetch(`https://test.local/analytics/${path}`);
      const explicit = await serviceFetch(
        `https://test.local/analytics/${path}${separator}scope=human`
      );
      expect(ordinary.status).toBe(200);
      expect(await ordinary.json()).toEqual(await explicit.json());
    }
    const dashboard = await serviceFetch("https://test.local/analytics/dashboard?scope=agent");
    const snapshot = await dashboard.json<AnalyticsDashboardResponse>();
    expect(snapshot.window.scope).toBe("agent");
    expect(snapshot.summary.totalSessions).toBe(1);
    expect(snapshot.breakdowns.model.entries[0]).toMatchObject({
      key: "anthropic/claude-haiku-4-5",
      sessions: 1,
    });
    expect(snapshot.breakdowns.harness.entries[0]).toMatchObject({
      key: "opencode",
      displayName: "OpenCode",
    });
    expect(snapshot.breakdowns.provider.entries[0]).toMatchObject({
      key: "anthropic",
      subscriptionSessions: 0,
    });
    expect(snapshot.breakdowns.automation.entries).toEqual([]);
    const humanDashboard = await (
      await serviceFetch("https://test.local/analytics/dashboard")
    ).json<AnalyticsDashboardResponse>();
    expect(humanDashboard.window.scope).toBe("human");
    expect(humanDashboard.summary.totalSessions).toBe(1);
    expect(humanDashboard.breakdowns.repository.entries[0].sessions).toBe(1);
    expect(humanDashboard.breakdowns.user.entries[0].sessions).toBe(1);
  });

  it("groups scoped spawn sources and named automations, excluding unlinked sessions", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - 60_000;
    await env.DB.prepare(
      `INSERT INTO automations
      (id, name, instructions, trigger_type, schedule_tz, model, enabled, consecutive_failures, created_by, created_at, updated_at)
      VALUES (?, 'Daily', 'Test', 'schedule', 'UTC', 'openai/gpt-5', 1, 0, 'test-user', ?, ?)`
    )
      .bind("daily", now, now)
      .run();
    for (const [id, source, automationId] of [
      ["human", "slack-bot", null],
      ["child", "agent", null],
      ["scheduled", "automation", "daily"],
      ["unlinked", "automation", null],
    ] as const) {
      await seedSession(store, {
        id,
        repoOwner: null,
        repoName: null,
        scmLogin: null,
        spawnSource: source,
        automationId: automationId ?? undefined,
        status: "completed",
        createdAt: now,
        updatedAt: now + 100,
        totalCost: 1,
        activeDurationMs: 100,
        messageCount: 1,
        prCount: 0,
      });
    }
    for (const [scope, total, source] of [
      ["human", 1, "slack-bot"],
      ["agent", 1, "agent"],
      ["automation", 2, "automation"],
      ["all", 4, "automation"],
    ] as const) {
      const summary = await (
        await serviceFetch(`https://test.local/analytics/summary?scope=${scope}`)
      ).json<AnalyticsSummaryResponse>();
      expect(summary.totalSessions).toBe(total);
      const breakdown = await (
        await serviceFetch(`https://test.local/analytics/breakdown?by=spawnSource&scope=${scope}`)
      ).json<AnalyticsBreakdownResponse>();
      expect(breakdown.entries).toContainEqual(expect.objectContaining({ key: source }));
    }
    const humanAutomation = await (
      await serviceFetch("https://test.local/analytics/breakdown?by=automation")
    ).json<AnalyticsBreakdownResponse>();
    expect(humanAutomation.entries).toEqual([]);
    const automations = await (
      await serviceFetch("https://test.local/analytics/breakdown?by=automation&scope=automation")
    ).json<AnalyticsBreakdownResponse>();
    expect(automations.entries).toEqual([
      expect.objectContaining({ key: "daily", displayName: "Daily", sessions: 1 }),
    ]);
  });

  it("merges canonical models and providers with weighted duration and matching subscription rows", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - 60_000;
    for (const [id, model, duration] of [
      ["first", "openai/gpt-5", 100],
      ["second", "openai/gpt-5.3-codex", 300],
      ["third", "openai/gpt-5.3-codex", 300],
      ["bare", "anthropic/claude-haiku-4-5", 200],
      ["prefixed", "anthropic/claude-haiku-4-5", 400],
    ] as const) {
      await seedSession(store, {
        id,
        model,
        harness: id === "prefixed" ? "claude" : "opencode",
        repoOwner: null,
        repoName: null,
        scmLogin: null,
        status: "completed",
        createdAt: now,
        updatedAt: now + duration,
        totalCost: 1,
        activeDurationMs: duration,
        messageCount: 1,
        prCount: 0,
      });
    }
    await env.DB.prepare("UPDATE sessions SET model = 'claude-haiku-4-5' WHERE id = 'bare'").run();
    for (const [id, provider] of [
      ["openai-account", "openai"],
      ["xai-account", "xai"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO model_provider_accounts (id, provider, display_name, status, created_at, updated_at)
        VALUES (?, ?, 'Test account', 'active', ?, ?)`
      )
        .bind(id, provider, now, now)
        .run();
    }
    await env.DB.prepare(
      "UPDATE session_model_provider_auth SET auth_mode = 'provider_account', provider_account_id = ? WHERE session_id = ? AND provider = ?"
    )
      .bind("openai-account", "first", "openai")
      .run();
    await env.DB.prepare(
      "UPDATE session_model_provider_auth SET auth_mode = 'provider_account', provider_account_id = ? WHERE session_id = ? AND provider = ?"
    )
      .bind("xai-account", "first", "xai")
      .run();
    for (const by of ["model", "harness", "spawnSource", "automation", "provider"] as const) {
      const response = await serviceFetch(`https://test.local/analytics/breakdown?by=${by}`);
      expect(response.status).toBe(200);
    }
    const models = await (
      await serviceFetch("https://test.local/analytics/breakdown?by=model")
    ).json<AnalyticsBreakdownResponse>();
    expect(models.entries).toContainEqual(
      expect.objectContaining({ key: "anthropic/claude-haiku-4-5", sessions: 2, avgDuration: 300 })
    );
    expect(models.entries.every((entry) => !("subscriptionSessions" in entry))).toBe(true);
    const harnesses = await (
      await serviceFetch("https://test.local/analytics/breakdown?by=harness")
    ).json<AnalyticsBreakdownResponse>();
    expect(harnesses.entries).toEqual([
      expect.objectContaining({ key: "opencode", displayName: "OpenCode", sessions: 4 }),
      expect.objectContaining({ key: "claude", displayName: "Claude Agent", sessions: 1 }),
    ]);
    const providers = await (
      await serviceFetch("https://test.local/analytics/breakdown?by=provider")
    ).json<AnalyticsBreakdownResponse>();
    expect(providers.entries).toEqual([
      expect.objectContaining({
        key: "openai",
        displayName: "OpenAI",
        sessions: 3,
        avgDuration: 700 / 3,
        subscriptionSessions: 1,
      }),
      expect.objectContaining({
        key: "anthropic",
        displayName: "Anthropic",
        sessions: 2,
        avgDuration: 300,
        subscriptionSessions: 0,
      }),
    ]);
    const dashboard = await (
      await serviceFetch("https://test.local/analytics/dashboard")
    ).json<AnalyticsDashboardResponse>();
    expect(dashboard.breakdowns.provider).toEqual(providers);
    expect(dashboard.breakdowns.model).toEqual(models);
  });
});
