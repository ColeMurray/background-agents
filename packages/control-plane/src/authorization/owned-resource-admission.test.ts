import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { AutomationStore, type AutomationRow } from "../db/automation-store";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { RequestContext } from "../http/request-context";
import { evaluateOwnedResourceAdmission } from "./owned-resource-admission";

const automation: AutomationRow = {
  id: "automation",
  owner_team_id: "team",
  user_id: null,
  created_by: "legacy-owner",
  name: "Automation",
  instructions: "Run tests",
  trigger_type: "schedule",
  schedule_cron: null,
  schedule_tz: "UTC",
  harness: "opencode",
  model: "anthropic/claude-sonnet-4-6",
  reasoning_effort: null,
  enabled: 1,
  next_run_at: null,
  consecutive_failures: 0,
  created_at: 1,
  updated_at: 1,
  deleted_at: null,
  event_type: null,
  trigger_config: null,
  trigger_auth_data: null,
};
const canonicalAutomation = { ...automation, user_id: "user" };
const environment: EnvironmentRow = {
  id: "environment",
  owner_team_id: "team",
  name: "Environment",
  description: null,
  prebuild_enabled: 0,
  channel_associations: null,
  created_at: 1,
  updated_at: 1,
};
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
      const hidden = await evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx);
      expect(ctx.automationAdmission?.automation ?? ctx.environmentAdmission?.environment).toBe(
        requirement.kind === "automation" ? automation : environment
      );
      expect(AutomationStore.prototype.resolveCanonicalOwner).not.toHaveBeenCalled();
      vi.mocked(AutomationStore.prototype.getById).mockResolvedValue(null);
      vi.mocked(EnvironmentStore.prototype.getById).mockResolvedValue(null);
      const missingCtx = context();
      const missing = await evaluateOwnedResourceAdmission(
        requirement,
        { id: "missing" },
        missingCtx
      );
      expect(hidden).toEqual(missing);
      expect(hidden).toEqual({
        kind: "denied",
        status: 404,
        response: {
          error:
            requirement.kind === "automation" ? "Automation not found" : "Environment not found",
        },
        reasonCode: `${requirement.kind}_not_visible`,
        reason:
          requirement.kind === "automation" ? "Automation not found" : "Environment not found",
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
    "denies $kind reads without read permission as 403, not an invisible 404",
    async (requirement) => {
      const read =
        requirement.kind === "automation"
          ? { ...requirement, operation: "read" as const }
          : { ...requirement, need: "read" as const };
      const result = await evaluateOwnedResourceAdmission(read, { id: "resource" }, context());
      expect(result).toEqual({
        kind: "denied",
        status: 403,
        response: {
          error: "Forbidden",
          code: `${requirement.kind}_action_denied`,
          reason_code: "missing_permission",
        },
        reasonCode: "missing_permission",
        reason: "Forbidden",
        ...(requirement.kind === "environment" ? { failedPermission: "environments.read" } : {}),
      });
    }
  );

  it.each([automationRequirement, environmentRequirement])(
    "retains the loaded $kind admission on action denial with shipped failed-permission evidence",
    async (requirement) => {
      const ctx = context();
      ctx.sessionMemberships = new Map([["team", "member"]]);
      vi.mocked(AutomationStore.prototype.resolveCanonicalOwner).mockResolvedValue({
        ...automation,
        user_id: "other-user",
      });
      const result = await evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx);
      expect(result).toEqual({
        kind: "denied",
        status: 403,
        response: {
          error: "Forbidden",
          code: `${requirement.kind}_action_denied`,
          reason_code: "not_owner_or_lead",
        },
        reasonCode: "not_owner_or_lead",
        reason: "Forbidden",
        ...(requirement.kind === "environment" ? { failedPermission: "environments.manage" } : {}),
      });
      expect(ctx.automationAdmission?.automation ?? ctx.environmentAdmission?.environment).toBe(
        requirement.kind === "automation" ? automation : environment
      );
    }
  );

  it.each([automationRequirement, environmentRequirement])(
    "preserves the $kind invalid-route versus service-ceiling check order without loading resources",
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
    }
  );

  it.each([
    { ...automationRequirement, operation: "read" },
    { ...environmentRequirement, need: "use" },
  ] as const)(
    "does not attribute user permissions to actorless $kind access",
    async (requirement) => {
      const ctx = context();
      ctx.principal = { kind: "service", service: "slack-bot", actor: null };
      ctx.authorization = undefined;
      await expect(
        evaluateOwnedResourceAdmission(requirement, { id: "resource" }, ctx)
      ).resolves.toEqual({ kind: "allowed", effectivePermission: null });
    }
  );
});
