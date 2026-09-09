/**
 * Unit tests for the automation lifecycle routes.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import {
  AutomationExecutionUnauthorizedError,
  AutomationTriggerBlockedError,
} from "../scheduler/scheduler";
import { createTestRequestHandler } from "../router.test-support";
import { automationRoutes } from "./automations";
import {
  mocks,
  mockStore,
  mockProviderAuthStore,
  mockProviderAccountStore,
  mockUserStore,
  mockEnvironmentStore,
  mockBatch,
  mockSchedulerTrigger,
  mockResolveGitHubCredentialAuthority,
  mockResolveGitHubEnrichmentForRequest,
  sampleRow,
  applyMockDefaults,
  automationRequest,
} from "./automations.test-support";

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: (...args: Parameters<typeof mocks.authenticate>) => mocks.authenticate(...args),
}));

vi.mock("../db/automation-store", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationStore: vi.fn().mockImplementation(function () {
      return mockStore;
    }),
    toAutomation: vi.fn((row: unknown) => row),
    toAutomationRun: vi.fn((row: unknown) => row),
  };
});

vi.mock("../db/automation-model-provider-auth", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    AutomationModelProviderAuthStore: vi.fn().mockImplementation(function () {
      return mockProviderAuthStore;
    }),
  };
});

vi.mock("../db/model-provider-accounts", () => ({
  ModelProviderAccountStore: vi.fn().mockImplementation(function () {
    return mockProviderAccountStore;
  }),
}));

vi.mock("../db/user-store", () => ({
  UserStore: vi.fn().mockImplementation(function () {
    return mockUserStore;
  }),
}));

vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return mockEnvironmentStore;
  }),
}));

vi.mock("../source-control/github-credential-authority", () => ({
  resolveGitHubCredentialAuthority: (...args: unknown[]) =>
    mockResolveGitHubCredentialAuthority(...args),
}));

vi.mock("../session/identity", () => ({
  resolveGitHubEnrichmentForRequest: (...args: unknown[]) =>
    mockResolveGitHubEnrichmentForRequest(...args),
}));

vi.mock("../scheduler/scheduler", () => ({
  AutomationExecutionUnauthorizedError: class AutomationExecutionUnauthorizedError extends Error {
    constructor() {
      super("Automation owner is not authorized to execute");
      this.name = "AutomationExecutionUnauthorizedError";
    }
  },
  AutomationTriggerBlockedError: class AutomationTriggerBlockedError extends Error {
    constructor() {
      super("An active run already exists");
      this.name = "AutomationTriggerBlockedError";
    }
  },
  Scheduler: vi.fn().mockImplementation(function () {
    return { trigger: (...args: unknown[]) => mockSchedulerTrigger(...args) };
  }),
}));

const callRoute = automationRequest(createTestRequestHandler([automationRoutes]));

describe("automation lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
  });

  describe("POST /automations/:id/pause", () => {
    it("pauses automation", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });

      const res = await callRoute("POST", "/automations/auto-1/pause");
      expect(res.status).toBe(200);
      expect(mockStore.bindPause).toHaveBeenCalledWith("auto-1");
    });

    it("returns 404 when not found", async () => {
      mockBatch.mockResolvedValue([{ meta: { changes: 0 }, results: [] }]);

      const res = await callRoute("POST", "/automations/missing/pause");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /automations/:id/resume", () => {
    it("resumes automation and recomputes next_run_at", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, enabled: 0 });

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(200);
      expect(mockStore.bindResume).toHaveBeenCalledWith("auto-1", expect.any(Number));
    });

    it("returns 404 when not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/resume");
      expect(res.status).toBe(404);
    });

    it("returns 400 when automation has no cron schedule", async () => {
      mockStore.getById.mockResolvedValue({
        ...sampleRow,
        schedule_cron: null,
      });

      const res = await callRoute("POST", "/automations/auto-1/resume");
      expect(res.status).toBe(400);
      const body = await res.json<{ error: string }>();
      expect(body.error).toContain("no cron schedule");
    });
  });

  describe("POST /automations/:id/trigger", () => {
    it("triggers automation via the scheduler", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.getActiveRunForAutomation.mockResolvedValue(null);
      const enrichment = {
        scmUserId: "123",
        scmLogin: "requester",
        accessTokenEncrypted: "encrypted-access",
      };
      mockResolveGitHubEnrichmentForRequest.mockResolvedValue(enrichment);

      const res = await callRoute("POST", "/automations/auto-1/trigger");
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        invocationId: "inv-1",
        runs: [{ id: "run-1" }],
      });
      expect(mockSchedulerTrigger).toHaveBeenCalledWith("auto-1", "user-1", enrichment);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("POST", "/automations/missing/trigger");
      expect(res.status).toBe(404);
    });

    it("returns 409 when the scheduler reports an active run", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);

      mockSchedulerTrigger.mockRejectedValue(new AutomationTriggerBlockedError());

      const res = await callRoute("POST", "/automations/auto-1/trigger");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "A run is already active for this automation",
      });
    });

    it("returns 403 when the owner is unauthorized to execute", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockSchedulerTrigger.mockRejectedValue(new AutomationExecutionUnauthorizedError());

      const res = await callRoute("POST", "/automations/auto-1/trigger");

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Execution authorization required" });
    });

    it("returns 500 when the scheduler cannot launch the automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockSchedulerTrigger.mockRejectedValue(new Error("launch failed"));

      const res = await callRoute("POST", "/automations/auto-1/trigger");

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to trigger automation" });
    });
  });
});
