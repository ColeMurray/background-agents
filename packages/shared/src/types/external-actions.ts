import { z } from "zod";

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
  .strict();

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
    findCredentialLikeKey(request.target, ["target"], context);
    findCredentialLikeKey(request.arguments, ["arguments"], context);
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

const CREDENTIAL_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "authorization",
  "password",
  "secret",
  "clientsecret",
  "privatekey",
  "cookie",
]);

function findCredentialLikeKey(
  value: unknown,
  path: PropertyKey[],
  context: z.RefinementCtx
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findCredentialLikeKey(entry, [...path, index], context));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (CREDENTIAL_KEYS.has(normalized)) {
      context.addIssue({
        code: "custom",
        path: [...path, key],
        message: "credential-like fields cannot cross the external action boundary",
      });
    }
    findCredentialLikeKey(entry, [...path, key], context);
  }
}

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
