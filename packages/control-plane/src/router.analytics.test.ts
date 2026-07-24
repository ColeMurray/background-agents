import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "./router";
import { signedServiceRequest, TEST_SERVICE_SECRETS } from "./router.test-support";

const mockStore = {
  getSummary: vi.fn(),
  getTimeseries: vi.fn(),
  getBreakdown: vi.fn(),
};

vi.mock("./db/analytics-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AnalyticsStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
  };
});

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
      ...TEST_SERVICE_SECRETS,
      SCM_PROVIDER: "gitlab",
      DB: {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
        dump: vi.fn(),
      },
    };

    const response = await handleRequest(
      await signedServiceRequest("https://test.local/analytics/summary"),
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
