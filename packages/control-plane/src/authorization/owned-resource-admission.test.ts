import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { AutomationStore, type AutomationRow } from "../db/automation-store";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { RequestContext } from "../http/request-context";
import { authorizeSessionTarget } from "../routes/session-target-authorization";
import { evaluateOwnedResourceAdmission } from "./owned-resource-admission";

// Full row validation is covered by D1 tests; admission consumes only ownership fields.
const automation = {
  id: "automation",
  owner_team_id: "team",
  user_id: null,
  created_by: "legacy-owner",
} as AutomationRow;
const canonicalAutomation = { ...automation, user_id: "user" };
const environment = { id: "environment", owner_team_id: "team" } as EnvironmentRow;
const automationRequirement = {
  kind: "automation",
  operation: "manage",
  automationIdParam: "id",
} as const;
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
      permissions: ["automations.manage.own", "environments.manage"],
      suspendedAt: null,
    },
    sessionMemberships: new Map([["team", "lead"]]),
  };
}

describe("owned-resource admission outcomes", () => {
  beforeEach(() => {
    vi.spyOn(AutomationStore.prototype, "getById").mockResolvedValue(automation);
    vi.spyOn(AutomationStore.prototype, "resolveCanonicalOwner").mockResolvedValue(
      canonicalAutomation
    );
    vi.spyOn(EnvironmentStore.prototype, "getById").mockResolvedValue(environment);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([automationRequirement, environmentRequirement])(
    "hides invisible $kind resources like missing resources, retaining denial audit context",
    async (requirement) => {
      const ctx = context();
      ctx.sessionMemberships = new Map();
      const message =
        requirement.kind === "automation" ? "Automation not found" : "Environment not found";
      const hidden = await evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx);
      expect(ctx.automationAdmission?.automation ?? ctx.environmentAdmission?.environment).toBe(
        requirement.kind === "automation" ? automation : environment
      );
      expect(AutomationStore.prototype.resolveCanonicalOwner).not.toHaveBeenCalled();
      vi.mocked(AutomationStore.prototype.getById).mockResolvedValue(null);
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
      const missingCtx = context();
      const missing = await evaluateOwnedResourceAdmission(requirement, { id: "id" }, missingCtx);
      expect(hidden).toEqual(missing);
      expect(hidden).toEqual({
        kind: "denied",
        status: 404,
        response: { error: message },
        reasonCode: `${requirement.kind}_not_visible`,
        reason: message,
      });
      expect(missingCtx.automationAdmission).toBeUndefined();
      expect(missingCtx.environmentAdmission).toBeUndefined();
    }
  );

  it.each([
    { requirement: automationRequirement, permission: "automations.manage.own" },
    { requirement: automationRequirement, permission: "automations.manage.any" },
    {
      requirement: { ...automationRequirement, operation: "trigger" },
      permission: "automations.trigger.own",
    },
    { requirement: environmentRequirement, permission: "environments.manage" },
    {
      requirement: { ...environmentRequirement, need: "use" },
      permission: "environments.use",
    },
  ] as const)("allows $permission without read permission", async ({ requirement, permission }) => {
    const ctx = context();
    ctx.authorization!.permissions = [permission];
    ctx.sessionMemberships = new Map([
      ["team", requirement.kind === "automation" ? "member" : "lead"],
    ]);
    vi.mocked(AutomationStore.prototype.resolveCanonicalOwner).mockImplementation(
      async (stored) => {
        expect(ctx.automationAdmission?.automation).toBe(stored);
        return canonicalAutomation;
      }
    );
    await expect(
      evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx)
    ).resolves.toEqual({ kind: "allowed", effectivePermission: permission });
    expect(ctx.automationAdmission?.automation ?? ctx.environmentAdmission?.environment).toBe(
      requirement.kind === "automation" ? canonicalAutomation : environment
    );
  });

  it.each([automationRequirement, environmentRequirement])(
    "maps visible $kind read/action denials to 403 and retains loaded audit context",
    async (requirement) => {
      vi.mocked(AutomationStore.prototype.resolveCanonicalOwner).mockResolvedValue({
        ...automation,
        user_id: "other-user",
      });
      for (const read of [true, false]) {
        const ctx = context();
        ctx.sessionMemberships = new Map([["team", "member"]]);
        const target = !read
          ? requirement
          : requirement.kind === "automation"
            ? { ...requirement, operation: "read" as const }
            : { ...requirement, need: "read" as const };
        const reason = read ? "missing_permission" : "not_owner_or_lead";
        expect(await evaluateOwnedResourceAdmission(target, { id: "resource" }, ctx)).toEqual({
          kind: "denied",
          status: 403,
          reasonCode: reason,
          reason: "Forbidden",
          response: {
            error: "Forbidden",
            code: `${requirement.kind}_action_denied`,
            reason_code: reason,
          },
          ...(requirement.kind === "environment"
            ? { failedPermission: `environments.${read ? "read" : "manage"}` }
            : {}),
        });
        expect(ctx.automationAdmission?.automation ?? ctx.environmentAdmission?.environment).toBe(
          requirement.kind === "automation" ? automation : environment
        );
      }
    }
  );

  it.each([automationRequirement, environmentRequirement])(
    "checks $kind service ceilings before lookup and attributes no actorless permissions",
    async (requirement) => {
      const ctx = context();
      ctx.principal = { kind: "service", service: "github-bot", actor: null };
      const denied = {
        kind: "denied",
        status: 403,
        response: { error: "Forbidden", code: "service_capability_required" },
        reasonCode: "service_capability_required",
        reason: "Forbidden",
      };
      await expect(evaluateOwnedResourceAdmission(requirement, {}, ctx)).resolves.toEqual(
        requirement.kind === "automation"
          ? denied
          : { kind: "error", status: 400, response: { error: "Invalid environment route" } }
      );
      await expect(
        evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx)
      ).resolves.toEqual(denied);
      expect(AutomationStore.prototype.getById).not.toHaveBeenCalled();
      expect(EnvironmentStore.prototype.getById).not.toHaveBeenCalled();
      ctx.principal = { kind: "service", service: "slack-bot", actor: null };
      ctx.authorization = undefined;
      const allowed =
        requirement.kind === "automation"
          ? { ...requirement, operation: "read" as const }
          : { ...requirement, need: "use" as const };
      await expect(
        evaluateOwnedResourceAdmission(allowed, { id: "resource" }, ctx)
      ).resolves.toEqual({ kind: "allowed", effectivePermission: null });
    }
  );

  it("maps suspended session target use before owner mismatch", async () => {
    const ctx = context();
    ctx.authorization!.permissions = ["environments.use"];
    ctx.authorization!.suspendedAt = 1;
    const response = await authorizeSessionTarget(ctx, {
      environmentId: "environment",
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

  it.each([null, "env_deleted"])(
    "allows sandbox clone inheritance with absent environment %s",
    async (environmentId) => {
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
      const ctx = context();
      ctx.principal = { kind: "sandbox", sessionId: "parent" };
      delete ctx.authorization;
      await expect(
        authorizeSessionTarget(ctx, { environmentId, hasRepository: true, ownerTeamId: "team" })
      ).resolves.toBeNull();
      expect(EnvironmentStore.prototype.getById).toHaveBeenCalledTimes(
        environmentId === null ? 0 : 1
      );
    }
  );
});
