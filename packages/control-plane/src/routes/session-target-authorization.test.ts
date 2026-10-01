import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { RequestContext } from "./shared";
import { authorizeSessionTarget } from "./session-target-authorization";

const environments = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock("../db/environments", () => ({
  EnvironmentStore: vi.fn().mockImplementation(function () {
    return environments;
  }),
}));

function context(suspendedAt: number | null = null): RequestContext {
  const userId = "11111111111111111111111111111111";
  const db: SqlDatabase = {
    prepare: () => {
      throw new Error("Unexpected SQL query");
    },
    batch: async () => [],
  };
  return {
    db,
    request_id: "target-authorization",
    trace_id: "target-authorization",
    metrics: createRequestMetrics(),
    executionCtx: createTestBackgroundTasks(),
    principal: { kind: "user", userId },
    authorization: {
      userId,
      role: { id: "role_builtin_member", key: "member", name: "Member" },
      permissions: ["environments.use"],
      suspendedAt,
    },
    sessionMemberships: new Map([
      ["team_a", "member"],
      ["team_b", "member"],
    ]),
  };
}

describe("session environment target authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    environments.getById.mockResolvedValue({ id: "env_a", owner_team_id: "team_a" });
  });

  it("includes the environment denial code and reason in an owned-use refusal", async () => {
    const response = await authorizeSessionTarget(context(1), {
      environmentId: "env_a",
      hasRepository: false,
      ownerTeamId: null,
    });
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Forbidden",
      code: "environment_action_denied",
      reason_code: "suspended",
    });
  });

  it.each([null, "team_b"])(
    "hides a nonmember's environment before owner mismatch (%s)",
    async (ownerTeamId) => {
      const ctx = context();
      ctx.sessionMemberships = new Map();
      const hidden = await authorizeSessionTarget(ctx, {
        environmentId: "env_a",
        hasRepository: false,
        ownerTeamId,
      });
      environments.getById.mockResolvedValue(null);
      const missing = await authorizeSessionTarget(ctx, {
        environmentId: "env_a",
        hasRepository: false,
        ownerTeamId,
      });
      expect(hidden?.status).toBe(404);
      expect(missing?.status).toBe(404);
      await expect(hidden?.json()).resolves.toEqual({ error: "Environment not found" });
      await expect(missing?.json()).resolves.toEqual({ error: "Environment not found" });
    }
  );

  it("allows member use without environment read permission", async () => {
    await expect(
      authorizeSessionTarget(context(), {
        environmentId: "env_a",
        hasRepository: false,
        ownerTeamId: "team_a",
      })
    ).resolves.toBeNull();
  });

  it.each([null, "team_b"])(
    "rejects a visible team environment for a different session owner (%s)",
    async (ownerTeamId) => {
      const response = await authorizeSessionTarget(context(), {
        environmentId: "env_a",
        hasRepository: false,
        ownerTeamId,
      });

      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toMatchObject({
        code: "environment_team_mismatch",
        reason_code: "environment_team_mismatch",
      });
    }
  );

  it.each([null, "team_a", "team_b"])(
    "allows a workspace environment for session owner %s",
    async (ownerTeamId) => {
      environments.getById.mockResolvedValue({ id: "env_workspace", owner_team_id: null });

      await expect(
        authorizeSessionTarget(context(), {
          environmentId: "env_workspace",
          hasRepository: false,
          ownerTeamId,
        })
      ).resolves.toBeNull();
    }
  );

  it.each([null, "team_b"])(
    "rejects a sandbox's immutable team environment for owner %s without human authorization",
    async (ownerTeamId) => {
      const ctx = context();
      ctx.principal = { kind: "sandbox", sessionId: "parent" };
      delete ctx.authorization;
      ctx.sessionMemberships = new Map();

      const response = await authorizeSessionTarget(ctx, {
        environmentId: "env_a",
        hasRepository: true,
        ownerTeamId,
      });

      expect(response?.status).toBe(409);
      await expect(response?.json()).resolves.toMatchObject({
        code: "environment_team_mismatch",
        reason_code: "environment_team_mismatch",
      });
    }
  );

  it.each([
    { environmentOwnerTeamId: "team_a", ownerTeamId: "team_a" },
    { environmentOwnerTeamId: null, ownerTeamId: null },
    { environmentOwnerTeamId: null, ownerTeamId: "team_a" },
  ])(
    "allows sandbox inheritance from $environmentOwnerTeamId to $ownerTeamId without human permissions",
    async ({ environmentOwnerTeamId, ownerTeamId }) => {
      environments.getById.mockResolvedValue({
        id: "env_a",
        owner_team_id: environmentOwnerTeamId,
      });
      const ctx = context();
      ctx.principal = { kind: "sandbox", sessionId: "parent" };
      delete ctx.authorization;
      ctx.sessionMemberships = new Map();

      await expect(
        authorizeSessionTarget(ctx, { environmentId: "env_a", hasRepository: true, ownerTeamId })
      ).resolves.toBeNull();
      expect(environments.getById).toHaveBeenCalledWith("env_a");
    }
  );

  it.each([null, "env_deleted"])(
    "preserves sandbox repository inheritance with absent environment %s",
    async (environmentId) => {
      environments.getById.mockResolvedValue(null);
      const ctx = context();
      ctx.principal = { kind: "sandbox", sessionId: "parent" };
      delete ctx.authorization;

      await expect(
        authorizeSessionTarget(ctx, { environmentId, hasRepository: true, ownerTeamId: "team_a" })
      ).resolves.toBeNull();
    }
  );
});
