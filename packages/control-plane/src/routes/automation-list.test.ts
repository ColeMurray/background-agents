/**
 * Unit tests for the automation listing routes.
 *
 * Tests run in Node (not workerd) with mocked stores and source control.
 * Requests dispatch through the production module, so admission (including
 * the automation ownership requirement) runs; authentication is mocked to
 * supply the principal.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestRequestHandler } from "../router.test-support";
import { MAX_NAME_LENGTH } from "./automation-validation";
import { automationRoutes } from "./automations";
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

describe("automation listing routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
  });

  describe("GET /automations (list)", () => {
    it("returns the first page with default pagination", async () => {
      mockStore.list.mockResolvedValue({
        automations: [sampleRow],
        hasMore: false,
        nextCursor: null,
      });

      const res = await callRoute("GET", "/automations");
      expect(res.status).toBe(200);

      const body = await res.json<{
        automations: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      }>();
      expect(body.automations).toHaveLength(1);
      expect(body.hasMore).toBe(false);
      expect(body.nextCursor).toBeNull();
      expect(mockStore.list).toHaveBeenCalledWith({ limit: 25, cursor: null });
      expect(mockStore.listRecentExecutionsForAutomationIds).toHaveBeenCalledWith(["auto-1"], 10);
      expect(body.automations[0]).toMatchObject({ recentExecutions: [] });
    });

    it.each<{ query: Record<string, string | string[]>; error: string }>([
      { query: { limit: "0" }, error: "Invalid limit" },
      { query: { limit: "abc" }, error: "Invalid limit" },
      { query: { limit: "101" }, error: "Invalid limit" },
      { query: { limit: ["5", "6"] }, error: "Invalid limit" },
      { query: { cursor: "not-a-cursor" }, error: "Invalid cursor" },
      { query: { search: "x".repeat(MAX_NAME_LENGTH + 1) }, error: "Search is too long" },
    ])("rejects list query $query without listing", async ({ query, error }) => {
      const res = await callRoute("GET", "/automations", { query });

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error });
      expect(mockStore.list).not.toHaveBeenCalled();
    });

    it("passes name search and pagination params to the store", async () => {
      mockStore.list.mockResolvedValue({ automations: [], hasMore: false, nextCursor: null });

      await callRoute("GET", "/automations", {
        query: { search: "  Daily sync  ", limit: "10", cursor: "123:auto-9" },
      });

      expect(mockStore.list).toHaveBeenCalledWith({
        nameSearch: "Daily sync",
        limit: 10,
        cursor: { createdAt: 123, id: "auto-9" },
      });
    });

    it("preserves explicit repository filters", async () => {
      mockStore.list.mockResolvedValue({ automations: [], hasMore: false, nextCursor: null });

      await callRoute("GET", "/automations", {
        query: { repoOwner: "acme", repoName: "web-app" },
      });

      expect(mockStore.list).toHaveBeenCalledWith({
        limit: 25,
        cursor: null,
        repoOwner: "acme",
        repoName: "web-app",
      });
    });

    it.each([
      [{ limit: "0" }, "limit"],
      [{ limit: "101" }, "limit"],
      [{ limit: "ten" }, "limit"],
      [{ limit: "1e1" }, "limit"],
      [{ limit: " 10 " }, "limit"],
      [{ limit: ["10", "20"] }, "limit"],
      [{ cursor: "not-a-cursor" }, "cursor"],
      [{ search: "a".repeat(201) }, "Search"],
    ])("rejects invalid pagination params", async (query, expectedField) => {
      const response = await callRoute("GET", "/automations", { query });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: expect.stringContaining(expectedField),
      });
      expect(mockStore.list).not.toHaveBeenCalled();
    });
  });
});
