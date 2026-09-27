import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { AnalyticsRunsResponse } from "@open-inspect/shared/types/analytics";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { SessionRunStore } from "../../src/db/session-run-store";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedSession(
  store: SessionIndexStore,
  input: Pick<SessionEntry, "id" | "createdAt" | "updatedAt"> &
    Partial<
      Pick<
        SessionEntry,
        | "parentSessionId"
        | "spawnDepth"
        | "spawnSource"
        | "userId"
        | "scmLogin"
        | "automationId"
        | "repoOwner"
        | "repoName"
      >
    >,
  cost: number,
  prs: number,
  tokens: number
): Promise<void> {
  await store.create({
    title: input.id,
    repoOwner: input.repoOwner ?? "acme",
    repoName: input.repoName ?? "app",
    model: "anthropic/claude-haiku-4-5",
    reasoningEffort: null,
    baseBranch: "main",
    status: "completed",
    ...input,
  });
  await store.updateMetrics(input.id, {
    totalCost: cost,
    prCount: prs,
    activeDurationMs: 0,
    messageCount: 0,
    inputTokens: tokens,
    outputTokens: tokens * 2,
    reasoningTokens: tokens * 3,
    cacheReadTokens: tokens * 4,
    cacheWriteTokens: tokens * 5,
  });
}

describe("session runs", () => {
  beforeEach(cleanD1Tables);

  it("rolls up a root, two children, and a grandchild with root ownership", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    const createdAt = now - 2 * DAY_MS;
    await seedSession(
      store,
      {
        id: "root",
        createdAt,
        updatedAt: createdAt + 10,
        userId: "owner-id",
        scmLogin: "owner-login",
        repoOwner: "group/subgroup",
        repoName: "project",
        spawnSource: "automation",
        automationId: "automation-1",
      },
      1,
      1,
      1
    );
    await seedSession(
      store,
      {
        id: "child-a",
        parentSessionId: "root",
        spawnDepth: 1,
        createdAt: createdAt + 100,
        updatedAt: createdAt + 110,
        userId: "different-user",
        scmLogin: "different-login",
        spawnSource: "agent",
      },
      2,
      0,
      2
    );
    await seedSession(
      store,
      {
        id: "child-b",
        parentSessionId: "root",
        spawnDepth: 1,
        createdAt: createdAt + 200,
        updatedAt: createdAt + 210,
      },
      3,
      1,
      3
    );
    await seedSession(
      store,
      {
        id: "grandchild",
        parentSessionId: "child-a",
        spawnDepth: 2,
        createdAt: createdAt + 300,
        updatedAt: createdAt + 310,
      },
      4,
      2,
      4
    );

    const response = await serviceFetch(
      "https://test.local/analytics/runs?days=7&limit=5&orderBy=cost"
    );
    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsRunsResponse>();
    expect(body.runs).toEqual([
      {
        rootSessionId: "root",
        sessionCount: 4,
        maxSpawnDepth: 2,
        totalCost: 10,
        totalPrs: 4,
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 30,
        cacheReadTokens: 40,
        cacheWriteTokens: 50,
        createdAt,
        updatedAt: createdAt + 310,
        userId: "owner-id",
        scmLogin: "owner-login",
        spawnSource: "automation",
        automationId: "automation-1",
        repoOwner: "group/subgroup",
        repoName: "project",
      },
    ]);
    expect(await new SessionRunStore(env.DB).get("root")).toEqual(body.runs[0]);
    expect(await new SessionRunStore(env.DB).get("missing")).toBeNull();
  });

  it("windows by root creation, not child creation, and includes later children", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    await seedSession(
      store,
      {
        id: "old-root",
        createdAt: now - 10 * DAY_MS,
        updatedAt: now - 10 * DAY_MS,
      },
      1,
      0,
      1
    );
    await seedSession(
      store,
      {
        id: "recent-child",
        parentSessionId: "old-root",
        spawnDepth: 1,
        createdAt: now - DAY_MS,
        updatedAt: now - DAY_MS,
      },
      2,
      1,
      2
    );
    await seedSession(
      store,
      {
        id: "recent-root",
        createdAt: now - 2 * DAY_MS,
        updatedAt: now - 2 * DAY_MS,
      },
      3,
      0,
      3
    );
    await seedSession(
      store,
      {
        id: "future-child",
        parentSessionId: "recent-root",
        spawnDepth: 1,
        createdAt: now + DAY_MS,
        updatedAt: now + DAY_MS,
      },
      4,
      1,
      4
    );

    const response = await serviceFetch("https://test.local/analytics/runs?days=7&orderBy=created");
    expect(response.status).toBe(200);
    const body = await response.json<AnalyticsRunsResponse>();
    expect(body.runs.map((run) => run.rootSessionId)).toEqual(["recent-root"]);
    expect(body.runs[0]).toMatchObject({ sessionCount: 2, totalCost: 7, totalPrs: 1 });

    const runs = await new SessionRunStore(env.DB).list({
      startAt: now - 11 * DAY_MS,
      endAt: now - 7 * DAY_MS,
      limit: 10,
      orderBy: "created",
    });
    expect(runs).toMatchObject([{ rootSessionId: "old-root", sessionCount: 2, totalCost: 3 }]);
  });

  it("orders by cost or creation time and applies the run limit", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now();
    await seedSession(
      store,
      {
        id: "older-expensive",
        createdAt: now - 3 * DAY_MS,
        updatedAt: now - 3 * DAY_MS,
      },
      8,
      0,
      0
    );
    await seedSession(
      store,
      {
        id: "newer-cheap",
        createdAt: now - DAY_MS,
        updatedAt: now - DAY_MS,
      },
      1,
      0,
      0
    );

    const runs = new SessionRunStore(env.DB);
    const window = { startAt: now - 7 * DAY_MS, endAt: now, limit: 1 };
    expect(
      (await runs.list({ ...window, orderBy: "cost" })).map((run) => run.rootSessionId)
    ).toEqual(["older-expensive"]);
    expect(
      (await runs.list({ ...window, orderBy: "created" })).map((run) => run.rootSessionId)
    ).toEqual(["newer-cheap"]);
  });
});
