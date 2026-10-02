import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { RequestContext } from "../http/request-context";
import { authorizeSessionTarget } from "../routes/session-target-authorization";
import { evaluateOwnedResourceAdmission } from "./owned-resource-admission";

// Full row validation is covered by D1 tests; admission consumes only ownership fields.
const environment = { id: "environment", owner_team_id: "team" } as EnvironmentRow;
const environmentRequirement = { kind: "environment", need: "manage", idParam: "id" } as const;

function context(): RequestContext {
  return {
    db: {
      prepare: () => {
        throw new Error("Unexpected SQL query");
      },
      batch: async () => [],
    },
    request_id: "owned-resource-admission",
    trace_id: "owned-resource-admission",
    metrics: createRequestMetrics(),
    executionCtx: createTestBackgroundTasks(),
    principal: { kind: "user", userId: "user" },
    authorization: {
      userId: "user",
      role: { id: "custom-role", key: null, name: "Custom" },
      permissions: ["environments.manage"],
      suspendedAt: null,
    },
    sessionMemberships: new Map([["team", "lead"]]),
  };
}

describe("owned-resource admission outcomes", () => {
  beforeEach(() => {
    vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(environment);
  });
  afterEach(() => vi.restoreAllMocks());

  it("hides invisible environments like missing ones, retaining denial audit context", async () => {
    const ctx = context();
    ctx.sessionMemberships = new Map();
    const hidden = await evaluateOwnedResourceAdmission(
      environmentRequirement,
      { id: "resource" },
      ctx
    );
    expect(ctx.environmentAdmission?.environment).toBe(environment);
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
    const missingCtx = context();
    const missing = await evaluateOwnedResourceAdmission(
      environmentRequirement,
      { id: "id" },
      missingCtx
    );
    expect(hidden).toEqual(missing);
    expect(hidden).toEqual({
      kind: "denied",
      status: 404,
      response: { error: "Environment not found" },
      reasonCode: "environment_not_visible",
      reason: "Environment not found",
    });
    expect(missingCtx.environmentAdmission).toBeUndefined();
  });

  it.each([
    { requirement: environmentRequirement, permission: "environments.manage" },
    {
      requirement: { ...environmentRequirement, need: "use" },
      permission: "environments.use",
    },
  ] as const)("allows $permission without read permission", async ({ requirement, permission }) => {
    const ctx = context();
    ctx.authorization!.permissions = [permission];
    await expect(
      evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx)
    ).resolves.toEqual({ kind: "allowed", effectivePermission: permission });
    expect(ctx.environmentAdmission?.environment).toBe(environment);
  });

  it("maps visible read/action denials to 403 and retains loaded audit context", async () => {
    for (const read of [true, false]) {
      const ctx = context();
      ctx.sessionMemberships = new Map([["team", "member"]]);
      const target = read
        ? { ...environmentRequirement, need: "read" as const }
        : environmentRequirement;
      const reason = read ? "missing_permission" : "not_owner_or_lead";
      expect(await evaluateOwnedResourceAdmission(target, { id: "resource" }, ctx)).toEqual({
        kind: "denied",
        status: 403,
        reasonCode: reason,
        reason: "Forbidden",
        response: { error: "Forbidden", code: "environment_action_denied", reason_code: reason },
        failedPermission: `environments.${read ? "read" : "manage"}`,
      });
      expect(ctx.environmentAdmission?.environment).toBe(environment);
    }
  });

  it("checks service ceilings before lookup and attributes no actorless permissions", async () => {
    const ctx = context();
    ctx.principal = { kind: "service", service: "github-bot", actor: null };
    await expect(evaluateOwnedResourceAdmission(environmentRequirement, {}, ctx)).resolves.toEqual({
      kind: "error",
      status: 400,
      response: { error: "Invalid environment route" },
    });
    await expect(
      evaluateOwnedResourceAdmission(environmentRequirement, { id: "resource" }, ctx)
    ).resolves.toEqual({
      kind: "denied",
      status: 403,
      response: { error: "Forbidden", code: "service_capability_required" },
      reasonCode: "service_capability_required",
      reason: "Forbidden",
    });
    expect(EnvironmentStore.prototype.getById).not.toHaveBeenCalled();
    ctx.principal = { kind: "service", service: "slack-bot", actor: null };
    ctx.authorization = undefined;
    await expect(
      evaluateOwnedResourceAdmission(
        { ...environmentRequirement, need: "use" },
        { id: "resource" },
        ctx
      )
    ).resolves.toEqual({ kind: "allowed", effectivePermission: null });
  });

  it("maps suspended session target use before owner mismatch", async () => {
    const ctx = context();
    ctx.authorization!.permissions = ["environments.use"];
    ctx.authorization!.suspendedAt = 1;
    const response = await authorizeSessionTarget(ctx, {
      teamId: null,
      environmentId: "environment",
      ownerTeamId: null,
    });
    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      error: "Forbidden",
      code: "environment_action_denied",
      reason_code: "suspended",
    });
  });

  it.each([null, "env_deleted"])(
    "allows sandbox clone inheritance with absent environment %s",
    async (environmentId) => {
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
      const ctx = context();
      ctx.principal = { kind: "sandbox", sessionId: "parent" };
      delete ctx.authorization;
      await expect(
        authorizeSessionTarget(ctx, {
          teamId: null,
          environmentId,
          repositories: [{ owner: "acme", name: "web" }],
          ownerTeamId: "team",
        })
      ).resolves.toBeNull();
      expect(EnvironmentStore.prototype.getById).toHaveBeenCalledTimes(
        environmentId === null ? 0 : 1
      );
    }
  );
});
