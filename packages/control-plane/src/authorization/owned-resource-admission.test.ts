import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { RequestContext } from "../http/request-context";
import {
  authorizeEnvironmentTarget,
  authorizeSessionTarget,
} from "../routes/session-target-authorization";
import { admittedEnvironment, evaluateOwnedResourceAdmission } from "./owned-resource-admission";

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

  it("hides invisible environments like missing ones, returning denial audit context", async () => {
    const ctx = context();
    ctx.sessionMemberships = new Map();
    const hidden = await evaluateOwnedResourceAdmission(
      environmentRequirement,
      { id: "resource" },
      ctx
    );
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
    const missing = await evaluateOwnedResourceAdmission(
      environmentRequirement,
      { id: "id" },
      context()
    );
    const { admission, ...response } = hidden as Extract<typeof hidden, { kind: "denied" }>;
    // Only the audit context differs; the HTTP-visible outcome is identical.
    expect(admission?.environment).toBe(environment);
    expect(missing).toEqual(response);
    expect(response).toEqual({
      kind: "denied",
      status: 404,
      response: { error: "Environment not found" },
      reasonCode: "environment_not_visible",
      reason: "Environment not found",
    });
    // Evaluation never writes request state; route admission owns that.
    expect(ctx.environmentAdmission).toBeUndefined();
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
    ).resolves.toEqual({
      kind: "allowed",
      effectivePermission: permission,
      admission: { environment, viewer: expect.objectContaining({ kind: "user" }) },
    });
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
        admission: { environment, viewer: expect.objectContaining({ kind: "user" }) },
      });
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
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue({
      ...environment,
      owner_team_id: null,
    });
    await expect(
      evaluateOwnedResourceAdmission(
        { ...environmentRequirement, need: "use" },
        { id: "resource" },
        ctx
      )
    ).resolves.toMatchObject({ kind: "allowed", effectivePermission: null });
  });

  it("hides team environments from actorless bots like missing ones", async () => {
    const ctx = context();
    ctx.principal = { kind: "service", service: "github-bot", actor: null };
    ctx.authorization = undefined;
    for (const need of ["read", "use"] as const) {
      await expect(
        evaluateOwnedResourceAdmission({ ...environmentRequirement, need }, { id: "resource" }, ctx)
      ).resolves.toMatchObject({ kind: "denied", status: 404 });
    }
  });

  it("refuses to hand a handler an environment that route admission did not load", () => {
    expect(() => admittedEnvironment(context())).toThrow("Route did not admit an environment");
  });

  it("applies canonical admission to session targets before owner mismatch", async () => {
    const ctx = context();
    ctx.authorization!.permissions = ["environments.use"];
    ctx.authorization!.suspendedAt = 1;
    const response = await authorizeEnvironmentTarget(ctx, {
      environmentId: "environment",
      ownerTeamId: null,
    });
    // Same concealment as route admission, rather than the 409 ownership mismatch.
    expect(response?.status).toBe(404);
    await expect(response?.json()).resolves.toEqual({ error: "Environment not found" });
  });

  it("allows sandbox clone inheritance with dangling environment provenance", async () => {
    vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
    const ctx = context();
    ctx.principal = { kind: "sandbox", sessionId: "parent" };
    delete ctx.authorization;
    await expect(
      authorizeEnvironmentTarget(ctx, { environmentId: "env_deleted", ownerTeamId: "team" })
    ).resolves.toBeNull();
    expect(EnvironmentStore.prototype.getById).toHaveBeenCalledOnce();
  });

  it("binds a sandbox's inherited team environment to the destination team", async () => {
    const ctx = context();
    ctx.principal = { kind: "sandbox", sessionId: "parent" };
    delete ctx.authorization;
    const response = await authorizeEnvironmentTarget(ctx, {
      environmentId: "environment",
      ownerTeamId: null,
    });
    expect(response?.status).toBe(409);
  });

  it("leaves environment admission out of the permission/grant preflight", async () => {
    const ctx = context();
    ctx.authorization!.permissions = ["environments.use"];
    await expect(
      authorizeSessionTarget(ctx, { teamId: null, environmentId: "environment" })
    ).resolves.toBeNull();
    expect(EnvironmentStore.prototype.getById).not.toHaveBeenCalled();
  });
});
