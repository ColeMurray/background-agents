import { z } from "zod";
import { assertNoCredentialLikeKeys } from "./credential-shaped";

export const MAX_EXTERNAL_ACTION_DOCUMENT_BYTES = 256 * 1024;

/** SessionDO-owned lifecycle for one idempotent external side effect. */
export const externalActionStateSchema = z.enum([
  "awaiting_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "denied",
  "indeterminate",
  "cancelled",
]);

export const externalActionApprovalSchema = z
  .object({
    source: z.enum(["human", "automation_grant"]),
    actorId: z.string().min(1),
    grantId: z.string().min(1).nullable(),
    approvedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((approval, context) => {
    // Provenance must be unambiguous. A human approval never carries a grant,
    // and an automation approval always names the grant that authorized it.
    // A mismatched pair would let a grant outlive its revocation or let a
    // human decision look like an automation one in the audit trail.
    if (approval.source === "human" && approval.grantId !== null) {
      context.addIssue({
        code: "custom",
        path: ["grantId"],
        message: "a human approval cannot carry an automation grant",
      });
    }
    if (approval.source === "automation_grant" && approval.grantId === null) {
      context.addIssue({
        code: "custom",
        path: ["grantId"],
        message: "an automation approval must name the grant that authorized it",
      });
    }
  });

/**
 * Credential-free action description crossing from PiSessionDO to SessionDO.
 * Provider credentials are resolved only by the executor after SessionDO claims execution.
 */
export const externalActionPrepareRequestSchema = z
  .object({
    toolCallId: z.string().min(1).max(256),
    idempotencyKey: z.string().min(1).max(512),
    provider: z.string().min(1).max(128),
    action: z.string().min(1).max(128),
    summary: z.string().min(1).max(1_000),
    target: z.record(z.string(), z.json()),
    arguments: z.record(z.string(), z.json()),
  })
  .strict()
  .superRefine((request, context) => {
    assertNoCredentialLikeKeys(request.target, context, ["target"]);
    assertNoCredentialLikeKeys(request.arguments, context, ["arguments"]);
    const documentBytes = new TextEncoder().encode(
      JSON.stringify({ target: request.target, arguments: request.arguments })
    ).byteLength;
    if (documentBytes > MAX_EXTERNAL_ACTION_DOCUMENT_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["arguments"],
        message: "external action document is too large",
      });
    }
  });

export const externalActionSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    operationId: z.string().min(1),
    toolCallId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    provider: z.string().min(1),
    action: z.string().min(1),
    summary: z.string().min(1),
    target: z.record(z.string(), z.json()),
    arguments: z.record(z.string(), z.json()),
    fingerprint: z.string().min(1),
    state: externalActionStateSchema,
    approval: externalActionApprovalSchema.nullable(),
    providerReference: z.string().nullable(),
    publicResult: z.json().nullable(),
    error: z.string().nullable(),
    revision: z.number().int().positive(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    /** When the pending approval expires. Null means the approval does not expire. */
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const externalActionHistoryEventSchema = z
  .object({
    revision: z.number().int().positive(),
    state: externalActionStateSchema,
    event: z.enum([
      "prepared",
      "approved",
      "denied",
      "execution_claimed",
      "execution_accepted",
      "execution_succeeded",
      "execution_failed",
      "execution_indeterminate",
      "reconciliation_pending",
      "reconciliation_not_admitted",
      "cancelled",
    ]),
    actorKind: z.enum(["pi", "user", "automation", "executor", "system"]),
    actorId: z.string().nullable(),
    reason: z.string().nullable(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();

export const externalActionStatusResponseSchema = z
  .object({
    action: externalActionSchema,
    history: z.array(externalActionHistoryEventSchema),
  })
  .strict();

/** A pending external effect an approver can act on. */
export const externalActionPendingSchema = z
  .object({
    id: z.string().min(1),
    provider: z.string().min(1),
    action: z.string().min(1),
    summary: z.string().min(1),
    state: externalActionStateSchema,
    target: z.record(z.string(), z.json()),
    arguments: z.record(z.string(), z.json()),
    approval: externalActionApprovalSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().nullable(),
  })
  .strict();

/** Cursor-bounded page of pending external effects. */
export const externalActionPendingListSchema = z
  .object({
    actions: z.array(externalActionPendingSchema),
    nextCursor: z.string().nullable(),
  })
  .strict();

export type ExternalActionPending = z.infer<typeof externalActionPendingSchema>;
export type ExternalActionPendingList = z.infer<typeof externalActionPendingListSchema>;
export type ExternalActionState = z.infer<typeof externalActionStateSchema>;
export type ExternalActionApproval = z.infer<typeof externalActionApprovalSchema>;
export type ExternalActionPrepareRequest = z.infer<typeof externalActionPrepareRequestSchema>;
export type ExternalAction = z.infer<typeof externalActionSchema>;
export type ExternalActionHistoryEvent = z.infer<typeof externalActionHistoryEventSchema>;
export type ExternalActionStatusResponse = z.infer<typeof externalActionStatusResponseSchema>;

/**
 * The stable tool name for one publication.
 *
 * The model calls it by this name, so it has to be the same on both sides of
 * the boundary and it has to stay the same when the deployment changes.
 */
export function externalActionToolName(provider: string, action: string): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9_]/g, "_");
  return `publish_${safe(provider)}_${safe(action)}`;
}
