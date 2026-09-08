import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleRequest,
  signedServiceRequest,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "./router.test-support";

const mockDashboardStore = {
  get: vi.fn(),
};

vi.mock("./db/analytics-dashboard-store", () => ({
  AnalyticsDashboardStore: vi.fn().mockImplementation(function () {
    return mockDashboardStore;
  }),
}));

describe("analytics router integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not let an actorless service read analytics", async () => {
    mockDashboardStore.get.mockResolvedValue({});

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
      await signedServiceRequest("https://test.local/analytics/dashboard", {
        service: "linear-bot",
      }),
      env as never,
      TEST_BACKGROUND_TASK_CONTEXT
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "service_actor_required" });
    expect(mockDashboardStore.get).not.toHaveBeenCalled();
  });
});
