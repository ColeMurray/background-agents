/**
 * GET /analytics/pull-requests — the PR value-stream analytics endpoint
 * (docs/pr-analytics-design.md). Everything here is scoped to PRs, never
 * sessions: cohort windowing, the PR-producing-session cost basis, the
 * merged-in-window population, open-PR inventory, and the source dimension.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { AnalyticsPullRequestsResponse, SpawnSource } from "@open-inspect/shared";
import { SessionIndexStore } from "../../src/db/session-index";
import {
  SessionPullRequestStore,
  type SessionPullRequestRecord,
} from "../../src/db/session-pull-request-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

function dateBucket(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

async function seedSession(input: {
  id: string;
  spawnSource: SpawnSource;
  totalCost: number;
  createdAt: number;
}): Promise<void> {
  const store = new SessionIndexStore(env.DB);
  await store.create({
    id: input.id,
    title: input.id,
    repoOwner: "acme",
    repoName: "web",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "completed",
    spawnSource: input.spawnSource,
    scmLogin: "alice",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  await store.updateMetrics(input.id, {
    totalCost: input.totalCost,
    activeDurationMs: 0,
    messageCount: 0,
    prCount: 0,
  });
}

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

describe("GET /analytics/pull-requests", () => {
  beforeEach(cleanD1Tables);

  it("reports the PR value stream scoped to PRs, never sessions", async () => {
    const prs = new SessionPullRequestStore(env.DB);
    const now = Date.now();
    const sessionCreatedAt = now - 5 * DAY_MS;

    await seedSession({
      id: "s-user",
      spawnSource: "user",
      totalCost: 1,
      createdAt: sessionCreatedAt,
    });
    await seedSession({
      id: "s-auto",
      spawnSource: "automation",
      totalCost: 2,
      createdAt: sessionCreatedAt,
    });
    // Sessions without PRs never appear anywhere in the PR analytics — not
    // as denominators and not in the cost basis.
    await seedSession({
      id: "s-nopr",
      spawnSource: "user",
      totalCost: 5,
      createdAt: sessionCreatedAt,
    });
    await seedSession({
      id: "s-old",
      spawnSource: "user",
      totalCost: 7,
      createdAt: sessionCreatedAt,
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

    const response = await serviceFetch("https://test.local/analytics/pull-requests?days=7");
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
    const response = await serviceFetch("https://test.local/analytics/pull-requests?days=30");
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
    const response = await serviceFetch("https://test.local/analytics/pull-requests?days=13");
    expect(response.status).toBe(400);
  });
});
