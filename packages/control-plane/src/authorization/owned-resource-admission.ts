import { checkAutomationAccess, checkEnvironmentAccess } from "@open-inspect/shared";
import {
  SCOPED_PERMISSION_PAIRS,
  resolveScopedPermission,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { AutomationStore } from "../db/automation-store";
import { EnvironmentStore } from "../db/environments";
import type { RequestContext } from "../http/request-context";
import type { RouteAuthorizationRequirement, RouteParams } from "../routes/shared";
import { resourceViewer } from "./resource-viewer";
import { serviceAllowsPermission } from "./service-permissions";

/** Resource decisions without accumulated route evidence or HTTP response construction. */
export type OwnedResourceAdmissionOutcome =
  | { kind: "allowed"; effectivePermission: PermissionId | null }
  | {
      kind: "denied";
      response: { error: string; code?: string; reason_code?: string };
      status: 403 | 404;
      reasonCode: string;
      reason: string;
      failedPermission?: PermissionId;
    }
  | { kind: "error"; response: { error: string }; status: 400 };

/** Infrastructure failures propagate to the router's authorization-unavailable boundary. */
export async function evaluateOwnedResourceAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" | "environment" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<OwnedResourceAdmissionOutcome> {
  if (requirement.kind === "automation") {
    if (
      ctx.principal?.kind === "service" &&
      !serviceAllowsPermission(ctx.principal.service, "automations.read")
    ) {
      return {
        kind: "denied",
        response: { error: "Forbidden", code: "service_capability_required" },
        status: 403,
        reasonCode: "service_capability_required",
        reason: "Forbidden",
      };
    }
    const automationId = params[requirement.automationIdParam];
    if (!automationId) {
      return { kind: "error", response: { error: "Invalid automation route" }, status: 400 };
    }

    const store = new AutomationStore(ctx.db);
    const storedAutomation = await store.getById(automationId);
    const viewer = await resourceViewer(ctx, storedAutomation?.owner_team_id ?? null);
    const row = storedAutomation && {
      ownerTeamId: storedAutomation.owner_team_id,
      executorUserId: storedAutomation.user_id,
    };
    if (storedAutomation) ctx.automationAdmission = { automation: storedAutomation, viewer };
    const read = row && checkAutomationAccess(viewer, row, "read");
    // Missing read permission does not block independently granted management or triggering.
    if (!storedAutomation || (read && !read.allowed && read.reason !== "missing_permission")) {
      return {
        kind: "denied",
        response: { error: "Automation not found" },
        status: 404,
        reasonCode: "automation_not_visible",
        reason: "Automation not found",
      };
    }
    const automation = await store.resolveCanonicalOwner(storedAutomation);
    const decision = checkAutomationAccess(
      viewer,
      {
        ownerTeamId: automation.owner_team_id,
        executorUserId: automation.user_id,
      },
      requirement.operation
    );
    if (!decision.allowed) {
      return {
        kind: "denied",
        response: {
          error: "Forbidden",
          code: "automation_action_denied",
          reason_code: decision.reason,
        },
        status: 403,
        reasonCode: decision.reason,
        reason: "Forbidden",
      };
    }
    let effectivePermission: PermissionId | null = null;
    if (viewer.kind === "user") {
      if (requirement.operation === "read") effectivePermission = "automations.read";
      else {
        const stem = `automations.${requirement.operation}` as const;
        const scope = resolveScopedPermission(stem, viewer.permissions);
        if (scope) effectivePermission = SCOPED_PERMISSION_PAIRS[stem][scope];
      }
    }
    ctx.automationAdmission = { automation, viewer };
    return { kind: "allowed", effectivePermission };
  }

  const id = params[requirement.idParam];
  if (!id) return { kind: "error", response: { error: "Invalid environment route" }, status: 400 };
  const permission = `environments.${requirement.need}` as const;
  if (
    ctx.principal?.kind === "service" &&
    !serviceAllowsPermission(ctx.principal.service, permission)
  ) {
    return {
      kind: "denied",
      response: { error: "Forbidden", code: "service_capability_required" },
      status: 403,
      reasonCode: "service_capability_required",
      reason: "Forbidden",
    };
  }
  const environment = await new EnvironmentStore(ctx.db).getById(id);
  const viewer = await resourceViewer(ctx, environment?.owner_team_id ?? null);
  if (environment) ctx.environmentAdmission = { environment, viewer };
  const read =
    environment &&
    checkEnvironmentAccess(viewer, { ownerTeamId: environment.owner_team_id }, "read");
  if (!environment || (read && !read.allowed && read.reason !== "missing_permission")) {
    return {
      kind: "denied",
      response: { error: "Environment not found" },
      status: 404,
      reasonCode: "environment_not_visible",
      reason: "Environment not found",
    };
  }
  const decision = checkEnvironmentAccess(
    viewer,
    { ownerTeamId: environment.owner_team_id },
    requirement.need
  );
  if (!decision.allowed) {
    return {
      kind: "denied",
      response: {
        error: "Forbidden",
        code: "environment_action_denied",
        reason_code: decision.reason,
      },
      status: 403,
      reasonCode: decision.reason,
      reason: "Forbidden",
      failedPermission: permission,
    };
  }
  return { kind: "allowed", effectivePermission: viewer.kind === "user" ? permission : null };
}
