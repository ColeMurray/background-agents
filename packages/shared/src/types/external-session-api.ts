import { z } from "zod";
import { clientRequestIdSchema, promptContentSchema } from "./prompts";
import { eventTypeSchema } from "./sandbox-events";
import { sessionStatusSchema } from "./sessions";

const requiredTextSchema = z.string().trim().min(1);
const idempotencyKeySchema = z.string().min(1).max(128);
export const externalEventCheckpointSchema = z.number().int().nonnegative();

export const externalEventFeedQuerySchema = z
  .strictObject({
    after: externalEventCheckpointSchema.optional(),
    cursor: requiredTextSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .refine((query) => query.after === undefined || query.cursor === undefined, {
    message: "after and cursor are mutually exclusive",
  });

export type ExternalEventFeedQuery = z.infer<typeof externalEventFeedQuerySchema>;

export const externalSessionListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
});

export type ExternalSessionListQuery = z.infer<typeof externalSessionListQuerySchema>;

export const externalCreateSessionRequestSchema = z.strictObject({
  title: requiredTextSchema,
  model: requiredTextSchema,
  reasoningEffort: requiredTextSchema.optional(),
  initialPrompt: promptContentSchema.refine((value) => value.trim().length > 0).optional(),
  idempotencyKey: idempotencyKeySchema,
});

export type ExternalCreateSessionRequest = z.infer<typeof externalCreateSessionRequestSchema>;

export const externalFollowUpRequestSchema = z.strictObject({
  content: promptContentSchema.refine((value) => value.trim().length > 0),
  clientRequestId: clientRequestIdSchema,
  model: requiredTextSchema.optional(),
  reasoningEffort: requiredTextSchema.optional(),
});

export type ExternalFollowUpRequest = z.infer<typeof externalFollowUpRequestSchema>;

export const externalSessionSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  status: sessionStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ExternalSession = z.infer<typeof externalSessionSchema>;

export const externalCreateSessionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({ sessionId: requiredTextSchema, status: z.literal("created") }),
  z.strictObject({
    sessionId: requiredTextSchema,
    messageId: requiredTextSchema,
    status: z.literal("queued"),
  }),
]);

export type ExternalCreateSessionResponse = z.infer<typeof externalCreateSessionResponseSchema>;

export const externalFollowUpResponseSchema = z.strictObject({
  messageId: requiredTextSchema,
  status: z.literal("queued"),
});

export const externalSessionListResponseSchema = z
  .strictObject({
    sessions: z.array(externalSessionSchema),
    hasMore: z.boolean(),
    continuationOffset: z.number().int().nonnegative().optional(),
  })
  .refine((response) => !response.hasMore || response.continuationOffset !== undefined, {
    message: "continuationOffset is required when hasMore is true",
    path: ["continuationOffset"],
  });

export const externalStopSessionResponseSchema = z.strictObject({
  status: z.literal("stopping"),
});

export type ExternalJsonValue =
  | null
  | boolean
  | number
  | string
  | ExternalJsonValue[]
  | { [key: string]: ExternalJsonValue };

const externalJsonValueSchema: z.ZodType<ExternalJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(externalJsonValueSchema),
    z.record(z.string(), externalJsonValueSchema),
  ])
);

export const externalEventSchema = z.strictObject({
  id: requiredTextSchema,
  type: eventTypeSchema,
  messageId: z.string().nullable(),
  createdAt: z.number(),
  data: z.record(z.string(), externalJsonValueSchema),
});

export type ExternalEvent = z.infer<typeof externalEventSchema>;

export const externalEventChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("upsert"),
    revision: externalEventCheckpointSchema,
    event: externalEventSchema,
  }),
  z.strictObject({
    kind: z.literal("delete"),
    revision: externalEventCheckpointSchema,
    eventId: requiredTextSchema,
  }),
]);

export type ExternalEventChange = z.infer<typeof externalEventChangeSchema>;

/** Event changes are retained for 24 hours or 50,000 revisions, whichever is reached first. */
export const externalEventPageSchema = z
  .strictObject({
    changes: z.array(externalEventChangeSchema),
    checkpoint: externalEventCheckpointSchema,
    cursor: requiredTextSchema.optional(),
    hasMore: z.boolean(),
  })
  .refine((page) => !page.hasMore || page.cursor !== undefined, {
    message: "cursor is required when hasMore is true",
    path: ["cursor"],
  });

export type ExternalEventPage = z.infer<typeof externalEventPageSchema>;

export const externalApiErrorResponseSchema = z
  .strictObject({
    error: requiredTextSchema,
    code: requiredTextSchema.optional(),
    permission: requiredTextSchema.optional(),
  })
  .refine((response) => response.permission === undefined || response.code !== undefined, {
    message: "code is required when permission is present",
    path: ["code"],
  });

export const externalSessionWaitResponseSchema = z.strictObject({
  sessionId: requiredTextSchema,
  status: sessionStatusSchema,
  settled: z.boolean(),
});
