import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsRoutes } from "./analytics";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const FIXED_NOW = 1_700_000_000_000;

const mockStore = {
  getSummary: vi.fn(),
  getTimeseries: vi.fn(),
  getBreakdown: vi.fn(),
};

vi.mock("../db/analytics-store", () => ({
  AnalyticsStore: vi.fn().mockImplementation(() => mockStore),
}));

function getHandler(method: string, path: string) {
  const pathname = new URL(`https://test.local${path}`).pathname;
  for (const route of analyticsRoutes) {
    if (route.method === method && route.pattern.test(pathname)) {
      const match = pathname.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }

  throw new Error(`No route found for ${method} ${path}`);
}

function createEnv(): Env {
  return {
    DB: {} as D1Database,
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

async function callRoute(method: string, path: string): Promise<Response> {
  const { handler, match } = getHandler(method, path);
  return handler(
    new Request(`https://test.local${path}`, { method }),
    createEnv(),
    match,
    createCtx()
  );
}

describe("analytics route handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("GET /analytics/summary", () => {
    it("defaults days to 30", async () => {
      mockStore.getSummary.mockResolvedValue({
        totalSessions: 12,
        activeUsers: 4,
        totalCost: 1.5,
        avgCost: 0.125,
        totalPrs: 2,
        statusBreakdown: {
          created: 1,
          active: 2,
          completed: 5,
          failed: 2,
          archived: 1,
          cancelled: 1,
        },
      });

      const response = await callRoute("GET", "/analytics/summary");
      expect(response.status).toBe(200);
      expect(mockStore.getSummary).toHaveBeenCalledWith({
        startAt: FIXED_NOW - 30 * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
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

  describe("GET /analytics/timeseries", () => {
    it("passes the requested range to the store", async () => {
      mockStore.getTimeseries.mockResolvedValue({ series: [] });

      const response = await callRoute("GET", "/analytics/timeseries?days=14");
      expect(response.status).toBe(200);
      expect(mockStore.getTimeseries).toHaveBeenCalledWith({
        startAt: FIXED_NOW - 14 * 24 * 60 * 60 * 1000,
        endAt: FIXED_NOW,
      });
    });
  });

  describe("GET /analytics/breakdown", () => {
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
  });
});
