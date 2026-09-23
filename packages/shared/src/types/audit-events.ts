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
 * Stored result for workspace operations and authorization decisions.
 *
 * For events written by an operation owner (for example `workspace.member_role_updated`), this is
 * the domain outcome. For `authorization.request_allowed` / `authorization.request_denied`, it only
 * encodes the admission decision: `applied` there means "allowed", not that the operation
 * succeeded. Classify those rows by `action`; `metadata.httpStatus` (schema
 * `authorization_decision.v1`) holds the response status when recorded.
 */
export const auditOperationResultSchema = z.enum(["applied", "no_op", "denied", "rejected"]);

/** Principal categories currently emitted by the control plane. */
export const auditPrincipalKindSchema = z.enum(["user", "service", "sandbox"]);

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

export type AuditOperationResult = z.infer<typeof auditOperationResultSchema>;
export type AuditPrincipalKind = z.infer<typeof auditPrincipalKindSchema>;
export type AuditEventMetadata = z.infer<typeof auditEventMetadataSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditEventListResponse = z.infer<typeof auditEventListResponseSchema>;
