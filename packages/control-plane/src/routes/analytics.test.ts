import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { HUMAN_SPAWN_SOURCES } from "../db/analytics-store";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";
import type { Env } from "../types";
import { analyticsRoutes, DEFAULT_ANALYTICS_DAYS } from "./analytics";

const FIXED_NOW = 1_700_000_000_000;

const mockStore = {
  getSummary: vi.fn(),
  getTimeseries: vi.fn(),
  getBreakdown: vi.fn(),
};

const mockDashboardStore = {
  get: vi.fn(),
};

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/analytics-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AnalyticsStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
  };
});

vi.mock("../db/analytics-dashboard-store", () => ({
  AnalyticsDashboardStore: vi.fn().mockImplementation(function () {
    return mockDashboardStore;
  }),
}));

const handleRequest = createTestRequestHandler([analyticsRoutes]);
const env = { ...TEST_SERVICE_SECRETS, DB: ownerAuthorizationDatabase() } as unknown as Env;

async function callRoute(method: string, path: string): Promise<Response> {
  return handleRequest(
    new Request(`https://test.local${path}`, { method }),
    env,
    TEST_BACKGROUND_TASK_CONTEXT
  );
}

describe("analytics route handlers", () => {
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

  describe("dashboard", () => {
    it("anchors one shared dashboard window", async () => {
      mockDashboardStore.get.mockResolvedValue({ generatedAt: FIXED_NOW });

      const response = await callRoute("GET", "/analytics/dashboard?days=14");

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ generatedAt: FIXED_NOW });
      expect(mockDashboardStore.get).toHaveBeenCalledWith({
        days: 14,
        startAt: FIXED_NOW - 14 * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
      });
    });

    it("rejects invalid ranges before querying", async () => {
      const response = await callRoute("GET", "/analytics/dashboard?days=31");

      expect(response.status).toBe(400);
      expect(mockDashboardStore.get).not.toHaveBeenCalled();
    });
  });

  describe("summary", () => {
    it("defaults days to 30", async () => {
      mockStore.getSummary.mockResolvedValue({
        totalSessions: 0,
        activeUsers: 0,
        prsOpened: 0,
        prsMerged: 0,
        mergeRate: 0,
        avgSessionDurationMs: 0,
        sessionsByStatus: [],
        sessionsByRepo: [],
        sessionsByUser: [],
        sessionsByModel: [],
        prBreakdown: [],
        recentSessions: [],
      });

      const response = await callRoute("GET", "/analytics/summary");
      expect(response.status).toBe(200);
      expect(mockStore.getSummary).toHaveBeenCalledWith({
        startAt: FIXED_NOW - DEFAULT_ANALYTICS_DAYS * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
        spawnSources: HUMAN_SPAWN_SOURCES,
      });
    });

    it("returns 400 for invalid days", async () => {
      const response = await callRoute("GET", "/analytics/summary?days=31");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "days must be one of: 7, 14, 30, 90",
      });
      expect(mockStore.getSummary).not.toHaveBeenCalled();
    });
  });

  describe("timeseries", () => {
    it("passes the requested range to the store", async () => {
      mockStore.getTimeseries.mockResolvedValue([]);

      const response = await callRoute("GET", "/analytics/timeseries?days=14");
      expect(response.status).toBe(200);
      expect(mockStore.getTimeseries).toHaveBeenCalledWith({
        startAt: FIXED_NOW - 14 * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
        spawnSources: HUMAN_SPAWN_SOURCES,
      });
    });
  });

  describe("breakdown", () => {
    it("requires a valid by parameter", async () => {
      const response = await callRoute("GET", "/analytics/breakdown?days=30");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "by must be one of: user, repo",
      });
    });

    it("returns 400 for invalid by values", async () => {
      const response = await callRoute("GET", "/analytics/breakdown?days=30&by=status");
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "by must be one of: user, repo",
      });
      expect(mockStore.getBreakdown).not.toHaveBeenCalled();
    });

    it("passes the breakdown dimension to the store", async () => {
      mockStore.getBreakdown.mockResolvedValue([]);

      const response = await callRoute("GET", "/analytics/breakdown?days=7&by=repo");
      expect(response.status).toBe(200);
      expect(mockStore.getBreakdown).toHaveBeenCalledWith(
        {
          startAt: FIXED_NOW - 7 * 24 * 60 * 60 * 1000,
          endAt: FIXED_NOW,
          spawnSources: HUMAN_SPAWN_SOURCES,
        },
        "repo"
      );
    });
  });

  describe("query strings", () => {
    it.each(["7", "14", "30", "90"])("accepts days=%s", async (days) => {
      mockStore.getSummary.mockResolvedValue({ ok: true });

      const response = await callRoute("GET", `/analytics/summary?days=${days}`);

      expect(response.status).toBe(200);
      expect(mockStore.getSummary).toHaveBeenCalledWith(
        expect.objectContaining({
          startAt: FIXED_NOW - Number(days) * 24 * 60 * 60 * 1000,
          endAt: FIXED_NOW,
        })
      );
    });

    it.each(["", "0", "8", "abc", "1e1"])("rejects days=%s", async (days) => {
      const response = await callRoute("GET", `/analytics/summary?days=${days}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "days must be one of: 7, 14, 30, 90",
      });
      expect(mockStore.getSummary).not.toHaveBeenCalled();
    });

    it("rejects a repeated days key", async () => {
      const response = await callRoute("GET", "/analytics/summary?days=7&days=14");

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid days" });
    });

    it("rejects an empty or repeated by key", async () => {
      const empty = await callRoute("GET", "/analytics/breakdown?days=30&by=");
      expect(empty.status).toBe(400);
      await expect(empty.json()).resolves.toEqual({ error: "by must be one of: user, repo" });

      const repeated = await callRoute("GET", "/analytics/breakdown?days=30&by=user&by=repo");
      expect(repeated.status).toBe(400);
      await expect(repeated.json()).resolves.toEqual({ error: "Invalid by" });
    });

    it("reports days before by when both are invalid", async () => {
      const response = await callRoute("GET", "/analytics/breakdown?days=1&by=nope");

      await expect(response.json()).resolves.toEqual({
        error: "days must be one of: 7, 14, 30, 90",
      });
    });
  });

  it("denies a request without analytics permission before touching a store", async () => {
    mocks.authenticate.mockImplementation(async () => ({
      reason: "Unauthorized",
      status: 401,
      failedScheme: "none",
    }));

    const response = await callRoute("GET", "/analytics/summary");
    expect(response.status).toBe(401);
    expect(mockStore.getSummary).not.toHaveBeenCalled();
  });
});
