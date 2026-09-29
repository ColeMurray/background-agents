import { beforeEach, describe, expect, it } from "vitest";
import { createExecutionContext, env } from "cloudflare:test";
import type { AnalyticsRunsResponse } from "@open-inspect/shared/types/analytics";
import { SessionIndexStore, type SessionEntry } from "../../src/db/session-index";
import { SessionRunStore } from "../../src/db/session-run-store";
import { cleanD1Tables } from "./cleanup";
import { routeRequest, serviceFetch, serviceRequestHeaders } from "./helpers";

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
        | "ownerTeamId"
        | "visibility"
      >
    >,
  cost: number,
  prs: number,
  tokens: number
): Promise<void> {
  await store.create({
    title: input.id,
    ownerTeamId: null,
    visibility: "workspace",
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
        title: "root",
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
    expect(
      await new SessionRunStore(env.DB, { kind: "internal", reason: "verify rollup" }, "on").get(
        "root"
      )
    ).toEqual(body.runs[0]);
    expect(
      await new SessionRunStore(
        env.DB,
        { kind: "internal", reason: "verify missing run" },
        "on"
      ).get("missing")
    ).toBeNull();
  });

  it("excludes an entire run when its root is hidden, even if a child is visible", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - DAY_MS;
    await env.DB.prepare(
      "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('hidden-run-team', 'hidden-run-team', 'Hidden', 1, 1)"
    ).run();
    await seedSession(
      store,
      {
        id: "hidden-root",
        createdAt: now,
        updatedAt: now,
        visibility: "team",
        ownerTeamId: "hidden-run-team",
      },
      4,
      0,
      0
    );
    await seedSession(
      store,
      {
        id: "visible-child",
        parentSessionId: "hidden-root",
        createdAt: now + 1,
        updatedAt: now + 1,
      },
      2,
      0,
      0
    );
    const url = "https://test.local/analytics/runs?scope=all";
    const response = await routeRequest(
      new Request(url, {
        headers: await serviceRequestHeaders(url, {
          as: { userId: "66666666666666666666666666666666", role: "member" },
        }),
      }),
      { ...env, TEAMS_ENFORCEMENT: "on" },
      createExecutionContext()
    );
    expect(response.status).toBe(200);
    expect((await response.json<AnalyticsRunsResponse>()).runs).toEqual([]);
    expect(
      await new SessionRunStore(
        env.DB,
        { kind: "internal", reason: "audit hidden roots" },
        "on"
      ).get("hidden-root")
    ).toMatchObject({ sessionCount: 2, totalCost: 6 });
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

    const runs = await new SessionRunStore(
      env.DB,
      { kind: "internal", reason: "verify old root window" },
      "on"
    ).list({
      startAt: now - 11 * DAY_MS,
      endAt: now - 7 * DAY_MS,
      limit: 10,
      orderBy: "created",
      scope: "all",
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

    const runs = new SessionRunStore(env.DB, { kind: "internal", reason: "verify ordering" }, "on");
    const window = { startAt: now - 7 * DAY_MS, endAt: now, limit: 1, scope: "all" as const };
    expect(
      (await runs.list({ ...window, orderBy: "cost" })).map((run) => run.rootSessionId)
    ).toEqual(["older-expensive"]);
    expect(
      (await runs.list({ ...window, orderBy: "created" })).map((run) => run.rootSessionId)
    ).toEqual(["newer-cheap"]);
  });

  it("keeps runs unfiltered by default but scopes explicit human roots and preserves null titles", async () => {
    const store = new SessionIndexStore(env.DB);
    const now = Date.now() - DAY_MS;
    await seedSession(
      store,
      { id: "human-root", spawnSource: "user", createdAt: now, updatedAt: now },
      1,
      0,
      0
    );
    await seedSession(
      store,
      { id: "agent-root", spawnSource: "agent", createdAt: now, updatedAt: now },
      2,
      0,
      0
    );
    await seedSession(
      store,
      { id: "automation-root", spawnSource: "automation", createdAt: now, updatedAt: now },
      3,
      0,
      0
    );
    await env.DB.prepare("UPDATE sessions SET title = NULL WHERE id = 'human-root'").run();
    const ordinary = await (
      await serviceFetch("https://test.local/analytics/runs")
    ).json<AnalyticsRunsResponse>();
    const all = await (
      await serviceFetch("https://test.local/analytics/runs?scope=all")
    ).json<AnalyticsRunsResponse>();
    expect(ordinary).toEqual(all);
    expect(ordinary.runs.map((run) => run.rootSessionId)).toEqual([
      "automation-root",
      "agent-root",
      "human-root",
    ]);
    const human = await (
      await serviceFetch("https://test.local/analytics/runs?scope=human")
    ).json<AnalyticsRunsResponse>();
    expect(human.runs).toEqual([
      expect.objectContaining({ rootSessionId: "human-root", title: null }),
    ]);
  });
});
