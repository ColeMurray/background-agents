import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateInternalToken } from "./auth/internal";
import { handleRequest } from "./router";

const mockStore = {
  getSummary: vi.fn(),
  getTimeseries: vi.fn(),
  getBreakdown: vi.fn(),
};

vi.mock("./db/analytics-store", () => ({
  AnalyticsStore: vi.fn().mockImplementation(() => mockStore),
}));

describe("analytics router integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serves analytics routes even when the SCM provider is not github", async () => {
    mockStore.getSummary.mockResolvedValue({
      totalSessions: 1,
      activeUsers: 1,
      totalCost: 0,
      avgCost: 0,
      totalPrs: 0,
      statusBreakdown: {
        created: 1,
        active: 0,
        completed: 0,
        failed: 0,
        archived: 0,
        cancelled: 0,
      },
    });

    const env = {
      INTERNAL_CALLBACK_SECRET: "test-secret",
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const token = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
    const response = await handleRequest(
      new Request("https://test.local/analytics/summary", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
      env as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      totalSessions: 1,
      activeUsers: 1,
      totalCost: 0,
      avgCost: 0,
      totalPrs: 0,
      statusBreakdown: {
        created: 1,
        active: 0,
        completed: 0,
        failed: 0,
        archived: 0,
        cancelled: 0,
      },
    });
  });
});
