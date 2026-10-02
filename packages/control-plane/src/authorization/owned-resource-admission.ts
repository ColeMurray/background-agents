import { checkEnvironmentAccess, type SessionViewer } from "@open-inspect/shared";
import type { PermissionId } from "@open-inspect/shared/rbac";
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

type EnvironmentNeed = Extract<RouteAuthorizationRequirement, { kind: "environment" }>["need"];

/** Route-parameter adapter for {@link evaluateEnvironmentAdmission}. */
export async function evaluateOwnedResourceAdmission(
  requirement: Extract<RouteAuthorizationRequirement, { kind: "environment" }>,
  params: RouteParams,
  ctx: RequestContext
): Promise<OwnedResourceAdmissionOutcome> {
  const id = params[requirement.idParam];
  if (!id) return { kind: "error", response: { error: "Invalid environment route" }, status: 400 };
  return evaluateEnvironmentAdmission(ctx, id, requirement.need);
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

/** HTTP response for an outcome that did not admit the resource. */
export function ownedResourceAdmissionResponse(
  outcome: Exclude<OwnedResourceAdmissionOutcome, { kind: "allowed" }>
): Response {
  return json(outcome.response, outcome.status);
}
