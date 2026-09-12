/**
 * Unit tests for the automation key regeneration route.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
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

const callRoute = automationRequest(createTestRequestHandler([automationRoutes]));

describe("automation key regeneration route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
  });

  describe("POST /automations/:id/regenerate-key", () => {
    it.each([123, "  "])(
      "rejects malformed sentry secret payloads before persistence",
      async (sentryClientSecret) => {
        mockStore.getById.mockResolvedValue({ ...sampleRow, trigger_type: "sentry" });

        const res = await callRoute("POST", "/automations/auto-1/regenerate-key", {
          body: { sentryClientSecret },
        });

        expect(res.status).toBe(400);
        await expect(res.json()).resolves.toEqual({ error: "sentryClientSecret is required" });
        expect(mockStore.update).not.toHaveBeenCalled();
      }
    );

    it("mints a webhook key the response forbids caches to keep", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, trigger_type: "webhook" });

      const res = await callRoute("POST", "/automations/auto-1/regenerate-key");

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = await res.json<{ webhookApiKey: string; webhookUrl: string }>();
      expect(body.webhookApiKey).toMatch(/\S/);
      expect(body.webhookUrl).toBe("/webhooks/automation/auto-1");
      expect(mockStore.bindAutomationUpdate).toHaveBeenCalledWith("auto-1", {
        trigger_auth_data: expect.not.stringContaining(body.webhookApiKey),
      });
    });

    it("returns 404 when the key update affects no current automation", async () => {
      mockStore.getById.mockResolvedValue({ ...sampleRow, trigger_type: "webhook" });
      mockBatch.mockResolvedValue([{ meta: { changes: 0 }, results: [] }]);

      const res = await callRoute("POST", "/automations/auto-1/regenerate-key");

      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toEqual({ error: "Automation not found" });
    });
  });
});
