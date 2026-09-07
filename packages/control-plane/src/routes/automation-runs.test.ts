/**
 * Unit tests for the automation run routes.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestRequestHandler } from "../router.test-support";
import { MAX_AUTOMATION_INVOCATION_LIST_LIMIT } from "@open-inspect/shared/types/automations";
import { automationRoutes } from "./automations";
import { DEFAULT_INVOCATION_LIST_LIMIT, MAX_INVOCATION_LIST_OFFSET } from "./automation-runs";
import {
  mocks,
  mockStore,
  mockProviderAuthStore,
  mockProviderAccountStore,
  mockUserStore,
  mockEnvironmentStore,
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

describe("automation run routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
  });

  describe("GET /automations/:id/invocations (list invocations)", () => {
    it("returns invocations for automation", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({
        invocations: [{ id: "inv-1", status: "completed", runs: [{ id: "run-1" }] }],
        total: 1,
      });

      const res = await callRoute("GET", "/automations/auto-1/invocations");
      expect(res.status).toBe(200);

      const body = await res.json<{ invocations: unknown[]; total: number }>();
      expect(body.invocations).toHaveLength(1);
      expect(body.total).toBe(1);
    });

    it("returns 404 when automation not found", async () => {
      mockStore.getById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/missing/invocations");
      expect(res.status).toBe(404);
    });

    it("respects limit and offset params", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/invocations", {
        query: { limit: "5", offset: "10" },
      });

      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: 5,
        offset: 10,
      });
    });

    it("lists the first default-sized page when the query names no page", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      await callRoute("GET", "/automations/auto-1/invocations");

      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: DEFAULT_INVOCATION_LIST_LIMIT,
        offset: 0,
      });
    });

    it("serves the deepest page and the largest page size", async () => {
      mockStore.getById.mockResolvedValue(sampleRow);
      mockStore.listInvocations.mockResolvedValue({ invocations: [], total: 0 });

      const res = await callRoute("GET", "/automations/auto-1/invocations", {
        query: {
          limit: String(MAX_AUTOMATION_INVOCATION_LIST_LIMIT),
          offset: String(MAX_INVOCATION_LIST_OFFSET),
        },
      });

      expect(res.status).toBe(200);
      expect(mockStore.listInvocations).toHaveBeenCalledWith("auto-1", {
        limit: MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
        offset: MAX_INVOCATION_LIST_OFFSET,
      });
    });

    it.each<{ query: Record<string, string | string[]>; error: string }>([
      { query: { limit: "0" }, error: "Invalid limit" },
      { query: { limit: "abc" }, error: "Invalid limit" },
      {
        query: { limit: String(MAX_AUTOMATION_INVOCATION_LIST_LIMIT + 1) },
        error: "Invalid limit",
      },
      { query: { limit: ["5", "6"] }, error: "Invalid limit" },
      { query: { offset: "-1" }, error: "Invalid offset" },
      { query: { offset: "abc" }, error: "Invalid offset" },
      { query: { offset: "1.5" }, error: "Invalid offset" },
      { query: { offset: String(MAX_INVOCATION_LIST_OFFSET + 1) }, error: "Invalid offset" },
      { query: { offset: ["0", "20"] }, error: "Invalid offset" },
    ])("rejects invocation query $query without listing", async ({ query, error }) => {
      mockStore.getById.mockResolvedValue(sampleRow);

      const res = await callRoute("GET", "/automations/auto-1/invocations", { query });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error });
      expect(mockStore.listInvocations).not.toHaveBeenCalled();
    });
  });

  describe("GET /automations/:id/runs/:runId (get run)", () => {
    it("returns a specific run", async () => {
      mockStore.getRunById.mockResolvedValue({ id: "run-1", status: "completed" });

      const res = await callRoute("GET", "/automations/auto-1/runs/run-1");
      expect(res.status).toBe(200);

      const body = await res.json<{ run: { id: string } }>();
      expect(body.run.id).toBe("run-1");
    });

    it("returns 404 when run not found", async () => {
      mockStore.getRunById.mockResolvedValue(null);

      const res = await callRoute("GET", "/automations/auto-1/runs/missing");
      expect(res.status).toBe(404);
    });
  });
});
