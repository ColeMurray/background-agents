import { beforeEach, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import type {
  AnalyticsBreakdownResponse,
  AnalyticsPullRequestsResponse,
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesResponse,
  SpawnSource,
} from "@open-inspect/shared";
import { generateInternalToken } from "../../src/auth/internal";
import { SessionIndexStore } from "../../src/db/session-index";
import {
  SessionPullRequestStore,
  type SessionPullRequestRecord,
} from "../../src/db/session-pull-request-store";
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
    repoOwner: string | null;
    repoName: string | null;
    baseBranch?: string | null;
    scmLogin: string | null;
    userId?: string | null;
    spawnSource?: SpawnSource;
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
    baseBranch:
      input.repoOwner !== null && input.repoName !== null ? (input.baseBranch ?? "main") : null,
    status: input.status,
    spawnSource: input.spawnSource,
    scmLogin: input.scmLogin,
    userId: input.userId,
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

    const response = await SELF.fetch("https://test.local/analytics/breakdown?days=30&by=user", {
      headers: await authHeaders(),
    });

    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsBreakdownResponse>();

    expect(body.entries).toEqual([
      {
        key: "alice",
        displayName: "alice",
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
      {
        key: "No repository",
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
    const summaryRes = await SELF.fetch("https://test.local/analytics/summary?days=7", {
      headers: await authHeaders(),
    });
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json<AnalyticsSummaryResponse>();
    expect(summary.totalSessions).toBe(4);
    expect(summary.activeUsers).toBe(2); // alice + bob (scm_login-based)
    expect(summary.totalCost).toBe(2.5);
    expect(summary.totalPrs).toBe(2);

    // Breakdown by user should include bot sessions, not agent/automation
    const breakdownRes = await SELF.fetch("https://test.local/analytics/breakdown?days=7&by=user", {
      headers: await authHeaders(),
    });
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
    const breakdownRes = await SELF.fetch(
      "https://test.local/analytics/breakdown?days=30&by=user",
      { headers: await authHeaders() }
    );
    expect(breakdownRes.status).toBe(200);
    const breakdown = await breakdownRes.json<AnalyticsBreakdownResponse>();

    expect(breakdown.entries).toEqual([
      {
        key: "user-abc",
        displayName: "Alice Smith",
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
    const summaryRes = await SELF.fetch("https://test.local/analytics/summary?days=30", {
      headers: await authHeaders(),
    });
    expect(summaryRes.status).toBe(200);
    const summary = await summaryRes.json<AnalyticsSummaryResponse>();
    expect(summary.activeUsers).toBe(2); // user-abc + bob

    // Timeseries: uses display name from users table
    const timeseriesRes = await SELF.fetch("https://test.local/analytics/timeseries?days=30", {
      headers: await authHeaders(),
    });
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
    const now = Date.now();
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

    const res = await SELF.fetch("https://test.local/analytics/timeseries?days=7", {
      headers: await authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json<AnalyticsTimeseriesResponse>();

    // Both sessions land on the same date with the same "Alex" label
    const dayBucket = dateBucket(dayAgo);
    const dayEntry = body.series.find((s) => s.date === dayBucket);
    expect(dayEntry).toBeDefined();
    // Reducer must sum, not overwrite: 1 + 1 = 2
    expect(dayEntry!.groups["Alex"]).toBe(2);
  });

  describe("pull request analytics", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    function makePrRecord(
      overrides: Partial<SessionPullRequestRecord> &
        Pick<SessionPullRequestRecord, "artifactId" | "sessionId" | "prNumber">
    ): SessionPullRequestRecord {
      const now = Date.now();
      return {
        repositoryExternalId: "9001",
        repoOwner: "acme",
        repoName: "web",
        url: `https://github.com/acme/web/pull/${overrides.prNumber}`,
        lifecycleState: "open",
        isDraft: false,
        headBranch: `open-inspect/${overrides.sessionId}`,
        baseBranch: "main",
        headSha: null,
        providerCreatedAt: null,
        providerUpdatedAt: 1_000,
        mergedAt: null,
        closedAt: null,
        createdAt: now,
        updatedAt: now,
        ...overrides,
      };
    }

    it("reports the PR value stream scoped to PRs, never sessions", async () => {
      const sessions = new SessionIndexStore(env.DB);
      const prs = new SessionPullRequestStore(env.DB);
      const now = Date.now();

      const sessionDefaults = {
        repoOwner: "acme",
        repoName: "web",
        scmLogin: "alice",
        status: "completed" as const,
        createdAt: now - 5 * DAY_MS,
        updatedAt: now - 5 * DAY_MS,
        activeDurationMs: 0,
        messageCount: 0,
        prCount: 0,
      };
      await seedSession(sessions, {
        ...sessionDefaults,
        id: "s-user",
        spawnSource: "user",
        totalCost: 1,
      });
      await seedSession(sessions, {
        ...sessionDefaults,
        id: "s-auto",
        spawnSource: "automation",
        totalCost: 2,
      });
      // Sessions without PRs never appear anywhere in the PR analytics — not
      // as denominators and not in the cost basis.
      await seedSession(sessions, {
        ...sessionDefaults,
        id: "s-nopr",
        spawnSource: "user",
        totalCost: 5,
      });
      await seedSession(sessions, {
        ...sessionDefaults,
        id: "s-old",
        spawnSource: "user",
        totalCost: 7,
      });

      // Cohort (created inside the 7d window):
      const p1 = makePrRecord({
        artifactId: "p1",
        sessionId: "s-user",
        prNumber: 1,
        lifecycleState: "merged",
        providerCreatedAt: now - 3 * DAY_MS,
        mergedAt: now - 2 * DAY_MS,
        closedAt: now - 2 * DAY_MS,
      });
      const p2 = makePrRecord({
        artifactId: "p2",
        sessionId: "s-user",
        prNumber: 2,
        providerCreatedAt: now - 1 * DAY_MS,
      });
      const p3 = makePrRecord({
        artifactId: "p3",
        sessionId: "s-auto",
        prNumber: 3,
        repositoryExternalId: "9002",
        repoName: "api",
        lifecycleState: "closed",
        providerCreatedAt: now - 2 * DAY_MS,
        closedAt: now - 1 * DAY_MS,
      });
      const p4 = makePrRecord({
        artifactId: "p4",
        sessionId: "s-auto",
        prNumber: 4,
        repositoryExternalId: "9002",
        repoName: "api",
        isDraft: true,
        providerCreatedAt: now - DAY_MS / 2,
      });
      // Merged pre-0042 row: no provider timestamps yet — counts in the
      // cohort funnel (via created_at fallback) but not in merged-in-window.
      const pLegacy = makePrRecord({
        artifactId: "p-legacy",
        sessionId: "s-user",
        prNumber: 5,
        lifecycleState: "merged",
        createdAt: now - 4 * DAY_MS,
      });
      // Created before the window, merged inside it: only the merge counts.
      const pOldMerged = makePrRecord({
        artifactId: "p-old",
        sessionId: "s-old",
        prNumber: 6,
        lifecycleState: "merged",
        providerCreatedAt: now - 10 * DAY_MS,
        mergedAt: now - 1 * DAY_MS,
        closedAt: now - 1 * DAY_MS,
      });
      for (const record of [p1, p2, p3, p4, pLegacy, pOldMerged]) {
        await prs.upsert(record);
      }

      const response = await SELF.fetch("https://test.local/analytics/pull-requests?days=7", {
        headers: await authHeaders(),
      });
      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsPullRequestsResponse>();

      expect(body.funnel).toEqual({ created: 5, open: 1, draft: 1, merged: 2, closed: 1 });

      // Cost basis: sessions with cohort PRs only (s-user + s-auto). The
      // PR-less session and the out-of-cohort session's costs are excluded.
      expect(body.prSessionCost).toBe(3);

      // Merged-in-window: p1 (1d cycle) + p-old (9d cycle); p-legacy has no
      // merged_at yet and is absent until read-through repairs it.
      expect(body.mergedInWindow).toBe(2);
      expect(body.avgTimeToMergeMs).toBe(5 * DAY_MS);

      expect(body.openInventory.total).toBe(2);
      // Ages are anchored to the request-time clock: 1d + 0.5d seeded, plus
      // the few ms between seeding and the request.
      expect(body.openInventory.avgAgeMs).toBeGreaterThanOrEqual(0.75 * DAY_MS);
      expect(body.openInventory.avgAgeMs).toBeLessThan(0.75 * DAY_MS + 60_000);

      expect(body.repos).toEqual([
        {
          key: "acme/web",
          created: 3,
          merged: 2,
          closed: 0,
          avgTimeToMergeMs: 1 * DAY_MS,
        },
        {
          key: "acme/api",
          created: 2,
          merged: 0,
          closed: 1,
          avgTimeToMergeMs: null,
        },
      ]);

      // Automation-spawned output is visible — source is a dimension, not a filter.
      expect(body.sources).toEqual([
        { source: "user", created: 3, merged: 2 },
        { source: "automation", created: 2, merged: 0 },
      ]);

      // Timeseries: created buckets from the cohort, merged buckets from
      // merged_at. Fold the seeded data the same way to stay timezone-safe.
      const expected = new Map<string, { created: number; merged: number }>();
      for (const record of [p1, p2, p3, p4, pLegacy]) {
        const date = dateBucket(record.providerCreatedAt ?? record.createdAt);
        const point = expected.get(date) ?? { created: 0, merged: 0 };
        point.created += 1;
        expected.set(date, point);
      }
      for (const mergedAt of [p1.mergedAt!, pOldMerged.mergedAt!]) {
        const date = dateBucket(mergedAt);
        const point = expected.get(date) ?? { created: 0, merged: 0 };
        point.merged += 1;
        expected.set(date, point);
      }
      expect(body.timeseries).toEqual(
        Array.from(expected.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, counts]) => ({ date, ...counts }))
      );
    });

    it("returns zeroed aggregates when no PRs exist", async () => {
      const response = await SELF.fetch("https://test.local/analytics/pull-requests?days=30", {
        headers: await authHeaders(),
      });
      expect(response.status).toBe(200);
      const body = await response.json<AnalyticsPullRequestsResponse>();

      expect(body).toEqual({
        funnel: { created: 0, open: 0, draft: 0, merged: 0, closed: 0 },
        prSessionCost: 0,
        mergedInWindow: 0,
        avgTimeToMergeMs: null,
        openInventory: { total: 0, avgAgeMs: null },
        timeseries: [],
        repos: [],
        sources: [],
      });
    });

    it("rejects an invalid days parameter", async () => {
      const response = await SELF.fetch("https://test.local/analytics/pull-requests?days=13", {
        headers: await authHeaders(),
      });
      expect(response.status).toBe(400);
    });
  });
});
