import type { PermissionId } from "@open-inspect/shared/rbac";
import type {
  AuthorizationDecisionRequirement,
  RouteAuthorizationDecision,
} from "../authorization/request-audit";
import { json } from "../http/responses";

export interface AuthorizationEvidence {
  requirements: AuthorizationDecisionRequirement[];
  effectivePermissions: PermissionId[];
}

/** A denial with optional audit evidence; infrastructure failures carry none. */
export interface AuthorizationFailure {
  response: Response;
  decision?: Extract<RouteAuthorizationDecision, { kind: "denied" }>;
  /** Deployment-capability refusals skip the general request log, as at the final gate. */
  requestLog?: "emit" | "skip";
}

export function authorizationDenial(
  response: Response,
  evidence: AuthorizationEvidence,
  failedRequirement: AuthorizationDecisionRequirement,
  reasonCode: string,
  reason: string,
  failedPermission?: PermissionId
): AuthorizationFailure {
  return {
    response,
    decision: {
      kind: "denied",
      ...evidence,
      requirements: [...evidence.requirements, failedRequirement],
      reasonCode,
      reason,
      ...(failedPermission ? { failedPermission } : {}),
    },
  };
}

export function authorizationUnavailable(): AuthorizationFailure {
  return {
    response: json({ error: "Authorization unavailable", code: "authorization_unavailable" }, 503),
  };
}
