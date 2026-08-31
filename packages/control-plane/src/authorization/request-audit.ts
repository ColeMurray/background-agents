import { SCOPED_PERMISSION_PAIRS } from "@open-inspect/shared/rbac";
import type { Route, RouteAuthorizationRequirement, RequestContext } from "../routes/shared";
import { createLogger } from "../logger";

const logger = createLogger("authorization-audit");

export type AuthorizationDecisionRequirement =
  | RouteAuthorizationRequirement
  | { kind: "active-user" }
  | { kind: "service-capability" };

function routeRequirements(route: Route): AuthorizationDecisionRequirement[] {
  if (route.authorization.kind === "active-user") return [...route.authorization.allOf];
  if (route.authorization.kind === "active-self" || route.authorization.kind === "active-global") {
    return [{ kind: "active-user" }];
  }
  if (route.authorization.kind === "service") return [{ kind: "service-capability" }];
  return [];
}

export function shouldAuditAllowedRoute(route: Route, method: string): boolean {
  if (method !== "GET") {
    return (
      route.authorization.kind === "active-user" ||
      route.authorization.kind === "active-self" ||
      route.authorization.kind === "active-global"
    );
  }
  if (route.authorization.kind !== "active-user") return false;
  return route.authorization.allOf.some((requirement) => {
    if (requirement.kind === "permission") {
      return (
        requirement.permission.endsWith(".manage") ||
        requirement.permission === "sessions.sandbox_access"
      );
    }
    return (
      (requirement.kind === "scoped-permission" && requirement.stem.endsWith(".manage")) ||
      (requirement.kind === "automation" && requirement.operation === "manage")
    );
  });
}

export async function auditRouteAuthorizationDecision(input: {
  ctx: RequestContext;
  route: Route;
  method: string;
  path: string;
  response: Response;
  allowed: boolean;
  requirement?: AuthorizationDecisionRequirement;
}): Promise<void> {
  const principal = input.ctx.principal;
  if (!principal || (!input.allowed && input.response.status !== 403)) return;

  let responseBody: { code?: unknown; error?: unknown; permission?: unknown } = {};
  if (!input.allowed) {
    try {
      responseBody = (await input.response.clone().json()) as typeof responseBody;
    } catch {
      // Denials without JSON bodies still carry their status in the audit metadata.
    }
  }
  const responseCode = typeof responseBody.code === "string" ? responseBody.code : null;
  const responseReason = typeof responseBody.error === "string" ? responseBody.error : null;
  const requirements = input.requirement ? [input.requirement] : routeRequirements(input.route);
  const permissionRequirement = requirements.find(
    (requirement) =>
      requirement.kind === "permission" ||
      requirement.kind === "scoped-permission" ||
      requirement.kind === "automation"
  );
  const requiredPermission =
    typeof responseBody.permission === "string"
      ? responseBody.permission
      : permissionRequirement?.kind === "permission"
        ? permissionRequirement.permission
        : permissionRequirement?.kind === "scoped-permission"
          ? SCOPED_PERMISSION_PAIRS[permissionRequirement.stem].own
          : permissionRequirement?.kind === "automation"
            ? SCOPED_PERMISSION_PAIRS[`automations.${permissionRequirement.operation}`].own
            : undefined;
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
    requirements,
    ...(requiredPermission ? { requiredPermission } : {}),
    responseCode,
    responseReason,
    requestId: input.ctx.request_id,
    traceId: input.ctx.trace_id,
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
        input.allowed ? "authorization.request_allowed" : "authorization.request_denied",
        input.path,
        input.allowed ? "authorization_allowed" : (responseCode ?? "authorization_denied"),
        input.allowed ? "applied" : "denied",
        JSON.stringify(metadata)
      )
      .run();
  } catch (cause) {
    logger.error("Authorization audit write failed", {
      event: "authorization.audit_failed",
      action: input.allowed ? "authorization.request_allowed" : "authorization.request_denied",
      error: cause instanceof Error ? cause : String(cause),
      request_id: input.ctx.request_id,
      trace_id: input.ctx.trace_id,
    });
  }
}
