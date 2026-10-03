import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import type * as AnalyticsStoreModule from "../db/analytics-store";
import {
  authorizationDatabase,
  createTestEnv,
  createTestRequestHandler,
  emptyStatement,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { SqlStatement } from "../db/sql-database";
import { AnalyticsStore } from "../db/analytics-store";
import { AnalyticsDashboardStore } from "../db/analytics-dashboard-store";
import { SessionRunStore } from "../db/session-run-store";
import { analyticsRoutes, DEFAULT_ANALYTICS_DAYS } from "./analytics";

const FIXED_NOW = 1_700_000_000_000;
const mockDashboardStore = { get: vi.fn() };
const mockRunStore = { list: vi.fn() };
const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/analytics-store", async (importOriginal) => ({
  ...(await importOriginal<typeof AnalyticsStoreModule>()),
  AnalyticsStore: vi.fn(),
}));

vi.mock("../db/analytics-dashboard-store", () => ({
  AnalyticsDashboardStore: vi.fn().mockImplementation(function () {
    return mockDashboardStore;
  }),
}));

vi.mock("../db/session-run-store", () => ({
  SessionRunStore: vi.fn().mockImplementation(function () {
    return mockRunStore;
  }),
}));

const handleRequest = createTestRequestHandler([analyticsRoutes]);
const env = createTestEnv({ ...TEST_SERVICE_SECRETS, DB: ownerAuthorizationDatabase() });

async function callRoute(path: string, testEnv = env): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local/analytics/${path}`),
    testEnv,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("analytics route contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns dashboard attribution unchanged with one window and the authorized viewer", async () => {
    const dashboard = {
      generatedAt: FIXED_NOW,
      sessionOrigins: [{ source: "user", userKey: "user-1", displayName: "Ada", sessions: 2 }],
    };
    mockDashboardStore.get.mockResolvedValue(dashboard);
    const membershipStatement: SqlStatement = {
      ...emptyStatement(),
      bind: () => membershipStatement,
      all: async <T>() => ({
        results: [{ team_id: "team-a", role: "member" }] as T[],
        meta: { changes: 0 },
      }),
    };
    const database = authorizationDatabase({
      statement: (sql) => {
        expect(sql).toContain("FROM team_memberships");
        return membershipStatement;
      },
    });

    const response = await callRoute("dashboard?days=14", {
      ...env,
      DB: database,
      TEAMS_ENFORCEMENT: "on",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(dashboard);
    expect(mockDashboardStore.get).toHaveBeenCalledWith({
      days: 14,
      scope: "human",
      startAt: FIXED_NOW - 14 * 24 * 60 * 60 * 1000,
      endAt: FIXED_NOW,
    });
    expect(AnalyticsDashboardStore).toHaveBeenCalledWith(
      expect.objectContaining({ prepare: expect.any(Function) }),
      expect.objectContaining({
        kind: "user",
        userId: "user-1",
        memberships: new Map([["team-a", "member"]]),
      }),
      "on"
    );
  });

  it.each([
    { query: "", days: DEFAULT_ANALYTICS_DAYS, limit: 50, orderBy: "cost", scope: "all" },
    {
      query: "?days=14&limit=10&orderBy=created&scope=human",
      days: 14,
      limit: 10,
      orderBy: "created",
      scope: "human",
    },
  ])("preserves runs options for '$query'", async ({ query, days, limit, orderBy, scope }) => {
    mockRunStore.list.mockResolvedValue([{ rootSessionId: "root" }]);
    const response = await callRoute(`runs${query}`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ runs: [{ rootSessionId: "root" }] });
    expect(mockRunStore.list).toHaveBeenCalledWith({
      startAt: FIXED_NOW - days * 24 * 60 * 60 * 1000,
      endAt: FIXED_NOW,
      limit,
      orderBy,
      scope,
    });
  });

  const daysError = "days must be one of: 7, 14, 30, 90";
  const scopeError = "scope must be one of: human, agent, automation, all";
  const byError =
    "by must be one of: user, repo, model, harness, spawnSource, automation, provider";
  const limitError = "limit must be an integer between 1 and 100";

  it.each([
    ["dashboard?days=31", daysError],
    ["summary?days=", daysError],
    ["summary?days=7&days=14", "Invalid days"],
    ["summary?scope=bogus", scopeError],
    ["summary?scope=human&scope=all", "Invalid scope"],
    ["breakdown", byError],
    ["breakdown?by=", byError],
    ["breakdown?by=status", byError],
    ["breakdown?by=user&by=repo", "Invalid by"],
    ["breakdown?days=1&by=nope", daysError],
    ["runs?days=31", daysError],
    ["runs?limit=0", limitError],
    ["runs?limit=101", limitError],
    ["runs?limit=1.5", limitError],
    ["runs?orderBy=other", "orderBy must be one of: cost, created"],
    ["runs?scope=other", scopeError],
    ["runs?orderBy=cost&orderBy=created", "Invalid orderBy"],
  ])("rejects %s before constructing a store", async (path, error) => {
    const response = await callRoute(path);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(AnalyticsStore).not.toHaveBeenCalled();
    expect(AnalyticsDashboardStore).not.toHaveBeenCalled();
    expect(SessionRunStore).not.toHaveBeenCalled();
  });

  it.each([401, 403])("denies %s before constructing any analytics store", async (status) => {
    if (status === 401) {
      mocks.authenticate.mockResolvedValue({
        reason: "Unauthorized",
        status: 401,
        failedScheme: "none",
      });
    }
    const deniedEnv = { ...env, DB: authorizationDatabase({ permissions: [] }) };
    for (const path of ["dashboard", "summary", "timeseries", "breakdown?by=user", "runs"]) {
      expect((await callRoute(path, deniedEnv)).status, path).toBe(status);
    }
    expect(AnalyticsStore).not.toHaveBeenCalled();
    expect(AnalyticsDashboardStore).not.toHaveBeenCalled();
    expect(SessionRunStore).not.toHaveBeenCalled();
  });
});
