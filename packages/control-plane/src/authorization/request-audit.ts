import type { PermissionId } from "@open-inspect/shared/rbac";
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
  return decision.auditAllowed;
}

export async function auditRouteAuthorizationDecision(input: {
  ctx: RequestContext;
  method: string;
  path: string;
  response: Response;
  decision: RouteAuthorizationDecision;
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
  const metadata = {
    schema: "authorization_decision.v1",
    httpMethod: input.method,
    httpPath: input.path,
    httpStatus: input.response.status,
    requirements: decision.requirements,
    ...(decision.effectivePermissions.length > 0
      ? { effectivePermissions: decision.effectivePermissions }
      : {}),
    ...(requiredPermission ? { requiredPermission } : {}),
    responseCode: decision.kind === "denied" ? decision.reasonCode : null,
    responseReason: decision.kind === "denied" ? decision.reason : null,
    requestId: input.ctx.request_id,
    traceId: input.ctx.trace_id,
    ...(decision.kind === "allowed" ? { admission: decision.admission } : {}),
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
  };

  try {
    await input.ctx.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind,
           actor_user_id_snapshot, actor_service_snapshot, action, resource_type, resource_id,
           reason_code, operation_result, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'http_route', ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.ctx.request_id,
        principal.kind,
        actorUserId ?? null,
        principal.kind === "service" ? principal.service : null,
        allowed ? "authorization.request_allowed" : "authorization.request_denied",
        input.path,
        decision.kind === "allowed" ? "authorization_allowed" : decision.reasonCode,
        allowed ? "applied" : "denied",
        JSON.stringify(metadata)
      )
      .run();
  } catch (cause) {
    logger.error("Authorization audit write failed", {
      event: "authorization.audit_failed",
      action: allowed ? "authorization.request_allowed" : "authorization.request_denied",
      error: cause instanceof Error ? cause : String(cause),
      request_id: input.ctx.request_id,
      trace_id: input.ctx.trace_id,
    });
  }
}
