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
    sessionMemberships: new Map([["team_a", "member"]]),
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
    });
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Forbidden",
      code: "environment_action_denied",
      reason_code: "suspended",
    });
  });

  it("hides a nonmember's environment like a missing environment", async () => {
    const ctx = context();
    ctx.sessionMemberships = new Map();
    const hidden = await authorizeSessionTarget(ctx, {
      environmentId: "env_a",
      hasRepository: false,
    });
    environments.getById.mockResolvedValue(null);
    const missing = await authorizeSessionTarget(ctx, {
      environmentId: "env_a",
      hasRepository: false,
    });
    expect(hidden?.status).toBe(404);
    expect(missing?.status).toBe(404);
    await expect(hidden?.json()).resolves.toEqual({ error: "Environment not found" });
    await expect(missing?.json()).resolves.toEqual({ error: "Environment not found" });
  });

  it("allows member use without environment read permission", async () => {
    await expect(
      authorizeSessionTarget(context(), { environmentId: "env_a", hasRepository: false })
    ).resolves.toBeNull();
  });
});
