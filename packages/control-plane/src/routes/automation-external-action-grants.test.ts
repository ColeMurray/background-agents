/**
 * Unit tests for the automation external-action grant routes.
 *
 * The routes dispatch through the production module, so admission runs: the
 * automation's own manage authority and the workspace permission that governs
 * external effects are both required.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestRequestHandler } from "../router.test-support";
import { automationRoutes } from "./automations";
import {
  applyMockDefaults,
  automationRequest,
  mocks,
  mockStore,
  sampleRow,
} from "./automations.test-support";

const mockGrants = {
  create: vi.fn(async () => true),
  findActive: vi.fn(async () => null),
  listByAutomation: vi.fn(async () => [] as unknown[]),
  revoke: vi.fn(async () => true),
};

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

vi.mock("../db/automation-external-action-grants", () => ({
  AutomationExternalActionGrantStore: vi.fn().mockImplementation(function () {
    return mockGrants;
  }),
}));

const callRoute = automationRequest(createTestRequestHandler([automationRoutes]));

describe("automation external-action grant routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyMockDefaults();
    mockGrants.create.mockResolvedValue(true);
    mockGrants.revoke.mockResolvedValue(true);
    mockGrants.listByAutomation.mockResolvedValue([]);
  });

  it("lists the grants an automation holds", async () => {
    mockGrants.listByAutomation.mockResolvedValue([
      {
        id: "grant-1",
        automationId: "auto-1",
        executorUserId: "user-1",
        provider: "github",
        action: "comment",
        createdBy: "user-1",
        createdAt: 1_700_000_000_000,
      },
    ]);

    const res = await callRoute("GET", "/automations/auto-1/external-action-grants");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      grants: [{ id: "grant-1", provider: "github", action: "comment" }],
    });
    expect(mockGrants.listByAutomation).toHaveBeenCalledWith("auto-1");
  });

  it("creates a grant that runs as the automation's own executor", async () => {
    const res = await callRoute("POST", "/automations/auto-1/external-action-grants", {
      body: { provider: "github", action: "comment" },
    });

    expect(res.status).toBe(201);
    const body = await res.json<{ grant: { executorUserId: string; provider: string } }>();
    expect(body.grant.executorUserId).toBe(sampleRow.user_id);
    expect(body.grant.provider).toBe("github");
    expect(mockGrants.create).toHaveBeenCalledWith(
      expect.objectContaining({
        automationId: "auto-1",
        executorUserId: "user-1",
        provider: "github",
        action: "comment",
        createdBy: "user-1",
      })
    );
  });

  it("refuses a grant body without a provider and action", async () => {
    const res = await callRoute("POST", "/automations/auto-1/external-action-grants", {
      body: { provider: "github" },
    });

    expect(res.status).toBe(400);
    expect(mockGrants.create).not.toHaveBeenCalled();
  });

  it("refuses to create a grant when the executor can no longer hold one", async () => {
    mockGrants.create.mockResolvedValue(false);

    const res = await callRoute("POST", "/automations/auto-1/external-action-grants", {
      body: { provider: "github", action: "comment" },
    });

    expect(res.status).toBe(409);
    expect(mockGrants.create).toHaveBeenCalled();
  });

  it("refuses grant administration without the external-action permission", async () => {
    const res = await callRoute("POST", "/automations/auto-1/external-action-grants", {
      body: { provider: "github", action: "comment" },
      permissions: ["automations.read", "automations.manage.own"],
    });

    expect(res.status).toBe(403);
    expect(mockGrants.create).not.toHaveBeenCalled();
  });

  it("revokes a grant inside the automation that owns it", async () => {
    const res = await callRoute("DELETE", "/automations/auto-1/external-action-grants/grant-1");

    expect(res.status).toBe(200);
    expect(mockGrants.revoke).toHaveBeenCalledWith(
      "grant-1",
      expect.any(Number),
      expect.any(String),
      "auto-1"
    );
  });

  it("reports a grant that is already revoked as not found", async () => {
    mockGrants.revoke.mockResolvedValue(false);

    const res = await callRoute("DELETE", "/automations/auto-1/external-action-grants/grant-1");

    expect(res.status).toBe(404);
  });
});
