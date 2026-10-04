import {
  checkAutomationAccess,
  checkEnvironmentAccess,
  type SessionViewer,
} from "@open-inspect/shared";
import {
  SCOPED_PERMISSION_PAIRS,
  resolveScopedPermission,
  type PermissionId,
} from "@open-inspect/shared/rbac";
import { AutomationStore } from "../db/automation-store";
import { EnvironmentStore, type EnvironmentRow } from "../db/environments";
import { json } from "../http/responses";
import type { RequestContext } from "../http/request-context";
import type { RouteAuthorizationRequirement, RouteParams } from "../routes/shared";
import { resourceViewer } from "./resource-viewer";
import { serviceAllowsPermission } from "./service-permissions";

/** The environment an admission loaded, with the viewer it was decided for. */
export interface EnvironmentAdmission {
  environment: EnvironmentRow;
  viewer: SessionViewer;
}

/**
 * Resource decisions without accumulated route evidence or HTTP response construction. Denials
 * carry the loaded environment, when there is one, so audits can attribute its owner team.
 */
export type OwnedResourceAdmissionOutcome =
  | { kind: "allowed"; effectivePermission: PermissionId | null; admission: EnvironmentAdmission }
  | {
      kind: "denied";
      admission?: EnvironmentAdmission;
      response: { error: string; code?: string; reason_code?: string };
      status: 403 | 404;
      reasonCode: string;
      reason: string;
      failedPermission?: PermissionId;
    }
  | { kind: "error"; response: { error: string }; status: 400 };

/** Automation decisions; an admitted automation is recorded on `ctx.automationAdmission`. */
export type AutomationAdmissionOutcome =
  | { kind: "allowed"; effectivePermission: PermissionId | null }
  | Omit<Extract<OwnedResourceAdmissionOutcome, { kind: "denied" }>, "admission">
  | Extract<OwnedResourceAdmissionOutcome, { kind: "error" }>;

type EnvironmentNeed = Extract<RouteAuthorizationRequirement, { kind: "environment" }>["need"];

/**
 * Route-parameter admission for owned automations and environments. Environments delegate to
 * {@link evaluateEnvironmentAdmission}; infrastructure failures propagate to the router.
 */
export async function evaluateOwnedResourceAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "environment" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<OwnedResourceAdmissionOutcome>;
export async function evaluateOwnedResourceAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<AutomationAdmissionOutcome>;
export async function evaluateOwnedResourceAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" | "environment" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<OwnedResourceAdmissionOutcome | AutomationAdmissionOutcome>;
export async function evaluateOwnedResourceAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" | "environment" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<OwnedResourceAdmissionOutcome | AutomationAdmissionOutcome> {
  if (requirement.kind === "automation") {
    return evaluateAutomationAdmission(requirement, params, ctx);
  }
  const id = params[requirement.idParam];
  if (!id) return { kind: "error", response: { error: "Invalid environment route" }, status: 400 };
  return evaluateEnvironmentAdmission(ctx, id, requirement.need);
}

async function evaluateAutomationAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "automation" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<AutomationAdmissionOutcome> {
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
  const viewer = await resourceViewer(ctx);
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
    { ownerTeamId: automation.owner_team_id, executorUserId: automation.user_id },
    requirement.operation
  );
  if (!decision.allowed) {
    return {
      kind: "denied",
      response: automationActionDeniedBody(decision.reason),
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

/**
 * Canonical environment admission for an ID from a path, query, or body: hidden environments
 * are indistinguishable from missing ones, and visible denials carry their reason. Infrastructure
 * failures propagate to the caller (the router's authorization-unavailable boundary).
 */
export async function evaluateEnvironmentAdmission(
  ctx: RequestContext,
  id: string,
  need: EnvironmentNeed
): Promise<OwnedResourceAdmissionOutcome> {
  const permission = `environments.${need}` as const;
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
  const viewer = await resourceViewer(ctx);
  const admission = environment ? { environment, viewer } : undefined;
  const read =
    environment &&
    checkEnvironmentAccess(viewer, { ownerTeamId: environment.owner_team_id }, "read");
  if (!environment || (read && !read.allowed && read.reason !== "missing_permission")) {
    return {
      kind: "denied",
      admission,
      response: { error: "Environment not found" },
      status: 404,
      reasonCode: "environment_not_visible",
      reason: "Environment not found",
    };
  }
  const decision = checkEnvironmentAccess(viewer, { ownerTeamId: environment.owner_team_id }, need);
  if (!decision.allowed) {
    return {
      kind: "denied",
      admission,
      response: environmentActionDeniedBody(decision.reason),
      status: 403,
      reasonCode: decision.reason,
      reason: "Forbidden",
      failedPermission: permission,
    };
  }
  return {
    kind: "allowed",
    effectivePermission: viewer.kind === "user" ? permission : null,
    admission: { environment, viewer },
  };
}

/** Body for a visible automation the viewer may not act on. */
export function automationActionDeniedBody(reason: string, error = "Forbidden") {
  return { error, code: "automation_action_denied", reason_code: reason };
}

/** Body for a visible environment the viewer may not act on. */
export function environmentActionDeniedBody(reason: string) {
  return { error: "Forbidden", code: "environment_action_denied", reason_code: reason };
}

/**
 * The environment route admission loaded for this request. Only handlers behind an
 * `environment` route requirement may call this; anything else is a routing bug.
 */
export function admittedEnvironment(ctx: RequestContext): EnvironmentAdmission {
  if (!ctx.environmentAdmission) throw new Error("Route did not admit an environment");
  return ctx.environmentAdmission;
}

/** Environment admission bound to one request, for policies that receive it as a dependency. */
export class EnvironmentAdmissionEvaluator {
  constructor(private readonly ctx: RequestContext) {}

  evaluate(id: string, need: EnvironmentNeed): Promise<OwnedResourceAdmissionOutcome> {
    return evaluateEnvironmentAdmission(this.ctx, id, need);
  }
}

/** HTTP response for an outcome that did not admit the resource. */
export function ownedResourceAdmissionResponse(
  outcome: Exclude<OwnedResourceAdmissionOutcome | AutomationAdmissionOutcome, { kind: "allowed" }>
): Response {
  return json(outcome.response, outcome.status);
}
