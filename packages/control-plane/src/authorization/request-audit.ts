import type { PermissionId } from "@open-inspect/shared/rbac";
import {
  AUTHORIZATION_DECISION_ACTIONS,
  AUTHORIZATION_DECISION_METADATA_SCHEMA,
  type AuthorizationDecisionMetadataV1,
} from "@open-inspect/shared/types/audit-events";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import type { RouteAuthorizationRequirement, RequestContext } from "../routes/shared";
import { createLogger } from "../logger";

const logger = createLogger("authorization-audit");

export type AuthorizationDecisionRequirement =
  | RouteAuthorizationRequirement
  | { kind: "active-user" }
  | { kind: "actorless-service-grant"; service: ServiceName }
  | { kind: "principal-type" }
  | { kind: "service-capability" }
  | { kind: "sandbox-admission"; sessionId: string };

interface AuthorizationDecisionEvidence {
  requirements: AuthorizationDecisionRequirement[];
  effectivePermissions: PermissionId[];
}

export type RouteAuthorizationDecision =
  | (AuthorizationDecisionEvidence & {
      kind: "allowed";
      admission: "user" | "service" | "sandbox";
      auditAllowed: boolean;
      shadowReason?: string;
      shadowDenials?: readonly { sessionId: string; reason: string }[];
    })
  | (AuthorizationDecisionEvidence & {
      kind: "denied";
      reasonCode: string;
      reason: string;
      failedPermission?: PermissionId;
    });

export function shouldAuditAllowedDecision(
  decision: Extract<RouteAuthorizationDecision, { kind: "allowed" }>
): boolean {
  return decision.auditAllowed || !!decision.shadowReason || !!decision.shadowDenials?.length;
}

/**
 * Records a route admission decision and the HTTP status the request returned.
 *
 * The event proves only that the request was allowed or denied and how the route responded. It
 * does not prove that any domain change or asynchronous work completed, even on a 2xx: the stored
 * `operation_result` of `applied` for an allowed request is the historical encoding of admission,
 * not a domain outcome. Readers classify these rows with the shared `interpretAuditEvent`. Evidence
 * that an operation completed must come from an event written by the operation owner, correlated
 * by request ID.
 */
export async function auditRouteAuthorizationDecision(input: {
  ctx: RequestContext;
  method: string;
  path: string;
  response: Response;
  decision: RouteAuthorizationDecision;
  teamId?: string | null;
}): Promise<void> {
  const principal = input.ctx.principal;
  if (!principal) return;

  const decision = input.decision;
  const allowed = decision.kind === "allowed";
  const requiredPermission =
    decision.kind === "allowed" ? decision.effectivePermissions[0] : decision.failedPermission;
  const actorUserId =
    principal.kind === "user"
      ? principal.userId
      : principal.kind === "service"
        ? (principal.actor?.canonicalUserId ?? input.ctx.authorization?.userId)
        : null;
  const action = allowed
    ? AUTHORIZATION_DECISION_ACTIONS.allowed
    : AUTHORIZATION_DECISION_ACTIONS.denied;
  const shadowCode =
    decision.kind === "allowed"
      ? decision.shadowDenials?.length
        ? "shadow_denied:batch"
        : decision.shadowReason
          ? `shadow_denied:${decision.shadowReason}`
          : null
      : null;
  const teamId =
    input.teamId !== undefined
      ? input.teamId
      : input.ctx.childSessionAdmission
        ? input.ctx.childSessionAdmission.row.ownerTeamId
        : (input.ctx.sessionAdmission?.row.ownerTeamId ??
          input.ctx.automationAdmission?.automation.owner_team_id ??
          input.ctx.environmentAdmission?.environment.owner_team_id ??
          input.ctx.projectAdmission?.project.ownerTeamId ??
          null);
  const metadata = {
    schema: AUTHORIZATION_DECISION_METADATA_SCHEMA,
    httpMethod: input.method,
    httpPath: input.path,
    httpStatus: input.response.status,
    requirements: decision.requirements,
    ...(decision.effectivePermissions.length > 0
      ? { effectivePermissions: decision.effectivePermissions }
      : {}),
    ...(requiredPermission ? { requiredPermission } : {}),
    responseCode: decision.kind === "denied" ? decision.reasonCode : shadowCode,
    responseReason: decision.kind === "denied" ? decision.reason : null,
    requestId: input.ctx.request_id,
    traceId: input.ctx.trace_id,
    ...(decision.kind === "allowed" ? { admission: decision.admission } : {}),
    ...(decision.kind === "allowed" && decision.shadowDenials?.length
      ? { shadowDenials: decision.shadowDenials }
      : {}),
    ...(principal.kind === "service" && principal.actor
      ? {
          actor: {
            provider: principal.actor.provider,
            providerUserId: principal.actor.providerUserId,
            participantUserId: principal.actor.participantUserId,
          },
        }
      : {}),
    ...(principal.kind === "sandbox" ? { sessionId: principal.sessionId } : {}),
  } satisfies AuthorizationDecisionMetadataV1;

  try {
    await input.ctx.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind,
           actor_user_id_snapshot, actor_service_snapshot, action, resource_type, resource_id,
            reason_code, operation_result, metadata_json, team_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'http_route', ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.ctx.request_id,
        principal.kind,
        actorUserId ?? null,
        principal.kind === "service" ? principal.service : null,
        action,
        input.path,
        decision.kind === "allowed" ? (shadowCode ?? "authorization_allowed") : decision.reasonCode,
        allowed ? "applied" : "denied",
        JSON.stringify(metadata),
        teamId
      )
      .run();
  } catch (cause) {
    logger.error("Authorization audit write failed", {
      event: "authorization.audit_failed",
      action,
      error: cause instanceof Error ? cause : String(cause),
      request_id: input.ctx.request_id,
      trace_id: input.ctx.trace_id,
    });
  }
}

export async function auditPrivateSessionBreakGlass(
  ctx: RequestContext,
  sessionId: string,
  teamId: string | null
): Promise<void> {
  const principal = ctx.principal;
  const actorUserId = ctx.authorization?.userId;
  if (!principal || !actorUserId) throw new Error("Missing private session break-glass actor");
  await ctx.db
    .prepare(
      `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
           actor_service_snapshot, action, resource_type, resource_id, team_id,
           reason_code, operation_result, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, 'session.private_break_glass', 'session', ?, ?, ?, 'applied', ?)`
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      ctx.request_id,
      principal.kind,
      actorUserId,
      principal.kind === "service" ? principal.service : null,
      sessionId,
      teamId,
      "session.private_break_glass",
      JSON.stringify({ before: {}, requested: {}, after: {} })
    )
    .run();
}
