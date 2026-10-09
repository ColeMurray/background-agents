import { z } from "zod";

export const MAX_AUDIT_EVENT_TIMESTAMP_MS = 8_640_000_000_000_000;

/** Nonnegative millisecond timestamp safe for cursors and JavaScript Date rendering. */
export const auditEventTimestampSchema = z
  .number()
  .int()
  .nonnegative()
  .safe()
  .max(MAX_AUDIT_EVENT_TIMESTAMP_MS);

/**
 * Stored result for workspace audit events.
 *
 * For events written by an operation owner (for example `workspace.member_role_updated`), this is
 * the domain outcome. For authorization decision actions it only encodes the admission decision:
 * `applied` there means "allowed", not that the operation succeeded. For observation actions, a
 * stored `denied` is hypothetical, not enforced. Use `interpretAuditEvent` rather than reading
 * this field directly.
 */
export const auditOperationResultSchema = z.enum(["applied", "no_op", "denied", "rejected"]);

/** Principal categories currently emitted by the control plane. */
export const auditPrincipalKindSchema = z.enum(["user", "service", "sandbox", "access-token"]);

/** Forward-compatible structured metadata attached to an audit event. */
export const auditEventMetadataSchema = z.record(z.string(), z.unknown());

/** A durable workspace audit event exposed by the audit log API. */
export const auditEventSchema = z
  .object({
    id: z.string().min(1),
    occurredAt: auditEventTimestampSchema,
    requestId: z.string().min(1),
    principalKind: auditPrincipalKindSchema,
    actorUserIdSnapshot: z.string().nullable(),
    actorServiceSnapshot: z.string().nullable(),
    action: z.string().min(1),
    resourceType: z.string().min(1),
    resourceId: z.string().nullable(),
    targetUserIdSnapshot: z.string().nullable(),
    reasonCode: z.string().min(1),
    operationResult: auditOperationResultSchema,
    metadata: auditEventMetadataSchema,
  })
  .strict();

/** A newest-first audit event page with a cursor exactly when another page exists. */
export const auditEventListResponseSchema = z.discriminatedUnion("hasMore", [
  z
    .object({
      events: z.array(auditEventSchema),
      hasMore: z.literal(false),
      nextCursor: z.null(),
    })
    .strict(),
  z
    .object({
      events: z.array(auditEventSchema),
      hasMore: z.literal(true),
      nextCursor: z.string().min(1),
    })
    .strict(),
]);

/** Actions written by route admission. They record a decision, never a domain outcome. */
export const AUTHORIZATION_DECISION_ACTIONS = {
  allowed: "authorization.request_allowed",
  denied: "authorization.request_denied",
} as const;

/** Observation-only actions: hypothetical shadow-policy decisions, not enforced domain outcomes. */
export const AUDIT_OBSERVATION_ACTIONS = ["session.shadow_denied"] as const;

/** Actions written by the operation owner alongside the change; their result is the domain outcome. */
export const AUDIT_OPERATION_ACTIONS = [
  "memory.created",
  "memory.revised",
  "memory.archived",
  "memory.restored",
  "memory.approved",
  "memory.rejected",
  "memory.superseded",
  "session.private_break_glass",
  "session.visibility_changed",
  "session.moved",
  "session.collaborator_added",
  "session.collaborator_removed",
  "session.created_private",
  "workspace.member_role_updated",
  "workspace.member_status_updated",
  "workspace.default_role_assigned",
  "workspace.owner_bootstrapped",
  "workspace.user_merged",
  "team.created",
  "team.updated",
  "team.archived",
  "team.restored",
  "team.member_added",
  "team.member_role_changed",
  "team.member_removed",
  "team.member_joined",
  "team.binding_added",
  "team.binding_removed",
  "team.grant_added",
  "team.grant_removed",
  "team.secret_set",
  "team.secret_deleted",
  "automation.executor_changed",
] as const;

export const AUTHORIZATION_DECISION_METADATA_SCHEMA = "authorization_decision.v1";

/** The `authorization_decision.v1` metadata fields readers rely on; other fields pass through. */
export const authorizationDecisionMetadataV1Schema = z.looseObject({
  schema: z.literal(AUTHORIZATION_DECISION_METADATA_SCHEMA),
  httpMethod: z.string(),
  httpPath: z.string(),
  httpStatus: z.number().int().min(100).max(599),
  requirements: z.array(z.unknown()),
});

/**
 * What an audit row proves, derived from its exact action rather than `operationResult`.
 *
 * - `authorization_decision`: the request was allowed or denied and, when v1 metadata parses,
 *   returned `httpStatus`. It never establishes a domain effect, even on a 2xx. Legacy rows and
 *   unknown metadata versions have no status.
 * - `observation`: shadow policy would deny the read. It does not establish an enforced denial or
 *   domain outcome, regardless of the legacy stored result.
 * - `operation`: the operation owner recorded this domain outcome.
 * - `unknown`: an action this contract does not recognize; its stored result is not interpreted.
 */
export type AuditEventInterpretation =
  | { kind: "authorization_decision"; decision: "allowed" | "denied"; httpStatus: number | null }
  | { kind: "observation"; observation: "would_deny" }
  | { kind: "operation"; result: AuditOperationResult }
  | { kind: "unknown" };

const DECISIONS_BY_ACTION = new Map<string, "allowed" | "denied">([
  [AUTHORIZATION_DECISION_ACTIONS.allowed, "allowed"],
  [AUTHORIZATION_DECISION_ACTIONS.denied, "denied"],
]);
const OBSERVATION_ACTIONS: ReadonlySet<string> = new Set(AUDIT_OBSERVATION_ACTIONS);
const OPERATION_ACTIONS: ReadonlySet<string> = new Set(AUDIT_OPERATION_ACTIONS);

export function interpretAuditEvent(
  event: Pick<AuditEvent, "action" | "operationResult" | "metadata">
): AuditEventInterpretation {
  const decision = DECISIONS_BY_ACTION.get(event.action);
  if (decision) {
    const metadata = authorizationDecisionMetadataV1Schema.safeParse(event.metadata);
    return {
      kind: "authorization_decision",
      decision,
      httpStatus: metadata.success ? metadata.data.httpStatus : null,
    };
  }
  if (OBSERVATION_ACTIONS.has(event.action)) {
    return { kind: "observation", observation: "would_deny" };
  }
  if (OPERATION_ACTIONS.has(event.action)) {
    return { kind: "operation", result: event.operationResult };
  }
  return { kind: "unknown" };
}

export type AuditOperationResult = z.infer<typeof auditOperationResultSchema>;
export type AuditOperationAction = (typeof AUDIT_OPERATION_ACTIONS)[number];
export type AuditObservationAction = (typeof AUDIT_OBSERVATION_ACTIONS)[number];
export type AuthorizationDecisionMetadataV1 = z.infer<typeof authorizationDecisionMetadataV1Schema>;
export type AuditPrincipalKind = z.infer<typeof auditPrincipalKindSchema>;
export type AuditEventMetadata = z.infer<typeof auditEventMetadataSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;
