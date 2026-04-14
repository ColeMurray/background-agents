import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import type {
  AnalyticsBreakdownResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
} from "@open-inspect/shared";
import { generateInternalToken } from "../../src/auth/internal";
import { SessionIndexStore } from "../../src/db/session-index";
import { cleanD1Tables } from "./cleanup";

async function authHeaders(): Promise<Record<string, string>> {
  const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET!);
  return { Authorization: `Bearer ${token}` };
}

function dateBucket(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function seedSession(
  store: SessionIndexStore,
  input: {
    id: string;
    repoOwner: string;
    repoName: string;
    scmLogin: string | null;
    status: "created" | "active" | "completed" | "failed" | "archived" | "cancelled";
    createdAt: number;
    updatedAt: number;
    totalCost: number;
    activeDurationMs: number;
    messageCount: number;
    prCount: number;
  }
): Promise<void> {
  await store.create({
    id: input.id,
    title: input.id,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: input.status,
    scmLogin: input.scmLogin,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });

  await store.updateMetrics(input.id, {
    totalCost: input.totalCost,
    activeDurationMs: input.activeDurationMs,
    messageCount: input.messageCount,
    prCount: input.prCount,
  });
}

describe("Analytics API", () => {
  beforeEach(cleanD1Tables);

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

    const response = await SELF.fetch("https://test.local/analytics/summary?days=30", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsSummaryResponse>();

    expect(body).toEqual({
      totalSessions: 6,
      activeUsers: 3,
      totalCost: 3,
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
    const now = Date.now();

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

    const response = await SELF.fetch("https://test.local/analytics/timeseries?days=7", {
      headers: await authHeaders(),
    });

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
          unknown: 1,
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

    const response = await SELF.fetch("https://test.local/analytics/breakdown?days=30&by=user", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsBreakdownResponse>();

    expect(body.entries).toEqual([
      {
        key: "alice",
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
        key: "bob",
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
      {
        key: "unknown",
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

    const response = await SELF.fetch("https://test.local/analytics/breakdown?days=30&by=repo", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsBreakdownResponse>();

    expect(body.entries).toEqual([
      {
        key: "acme/web-app",
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
    ]);
  });
});
