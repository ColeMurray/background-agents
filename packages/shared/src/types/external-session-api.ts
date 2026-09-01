import { z } from "zod";
import { clientRequestIdSchema, promptContentSchema } from "./prompts";
import { modelProviderSelectionsSchema } from "./provider-accounts";
import { sessionRepositoriesInputSchema } from "./repositories";
import { eventTypeSchema } from "./sandbox-events";
import { sessionAttachmentReferencesSchema } from "./session-attachments";
import { sessionSkillSelectionSchema } from "./skills";
import { sessionStatusSchema } from "./sessions";

const requiredTextSchema = z.string().trim().min(1);
const idempotencyKeySchema = z.string().min(1).max(128);
export const externalEventCheckpointSchema = z.number().int().nonnegative();

export const externalEventFeedQuerySchema = z
  .strictObject({
    after: externalEventCheckpointSchema.optional(),
    cursor: requiredTextSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .refine((query) => query.after === undefined || query.cursor === undefined, {
    message: "after and cursor are mutually exclusive",
  });

export type ExternalEventFeedQuery = z.infer<typeof externalEventFeedQuerySchema>;

export const externalSessionListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().nonnegative().optional(),
  status: sessionStatusSchema.optional(),
  excludeStatus: sessionStatusSchema.optional(),
  excludeAutomationLineage: z.boolean().optional(),
  createdBy: requiredTextSchema.optional(),
});

export type ExternalSessionListQuery = z.infer<typeof externalSessionListQuerySchema>;

const externalCreateSessionRequestBaseSchema = z.strictObject({
  repoOwner: requiredTextSchema.optional(),
  repoName: requiredTextSchema.optional(),
  branch: requiredTextSchema.optional(),
  repositories: sessionRepositoriesInputSchema.optional(),
  environmentId: requiredTextSchema.optional(),
  title: requiredTextSchema.optional(),
  model: requiredTextSchema.optional(),
  reasoningEffort: requiredTextSchema.optional(),
  skillSelection: sessionSkillSelectionSchema.optional(),
  providerSelections: modelProviderSelectionsSchema.optional(),
  initialPrompt: promptContentSchema.optional(),
  initialAttachments: sessionAttachmentReferencesSchema.optional(),
  initialAttachmentCount: z.number().int().min(1).max(6).optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const externalCreateSessionRequestSchema = externalCreateSessionRequestBaseSchema
  .refine((value) => Boolean(value.repoOwner) === Boolean(value.repoName), {
    message: "repoOwner and repoName must be provided together",
    path: ["repoName"],
  })
  .refine((value) => !value.branch || Boolean(value.repoOwner), {
    message: "branch requires repoOwner and repoName",
    path: ["branch"],
  })
  .refine(
    (value) =>
      [
        Boolean(value.repoOwner),
        value.repositories !== undefined,
        Boolean(value.environmentId),
      ].filter(Boolean).length <= 1,
    {
      message: "repository, repositories, and environmentId are mutually exclusive",
      path: ["repositories"],
    }
  )
  .refine(
    (value) =>
      value.initialPrompt === undefined ||
      value.initialPrompt.trim().length > 0 ||
      Boolean(value.initialAttachments?.length) ||
      Boolean(value.initialAttachmentCount),
    {
      message: "initialPrompt must not be blank without attachments",
      path: ["initialPrompt"],
    }
  );

export type ExternalCreateSessionRequest = z.infer<typeof externalCreateSessionRequestSchema>;

export const externalFollowUpRequestSchema = z
  .strictObject({
    content: promptContentSchema.optional(),
    attachments: sessionAttachmentReferencesSchema.optional(),
    clientRequestId: clientRequestIdSchema,
    model: requiredTextSchema.optional(),
    reasoningEffort: requiredTextSchema.optional(),
  })
  .refine((value) => Boolean(value.content?.trim()) || Boolean(value.attachments?.length), {
    message: "content or attachments are required",
    path: ["content"],
  });

export type ExternalFollowUpRequest = z.infer<typeof externalFollowUpRequestSchema>;

export const externalSessionSchema = z.strictObject({
  id: z.string(),
  title: z.string().nullable(),
  model: z.string(),
  reasoningEffort: z.string().nullable(),
  status: sessionStatusSchema,
  repoOwner: z.string().nullable().optional(),
  repoName: z.string().nullable().optional(),
  repositories: z
    .array(
      z.strictObject({
        repoOwner: z.string(),
        repoName: z.string(),
        repoId: z.number().nullable(),
        baseBranch: z.string(),
      })
    )
    .optional(),
  environmentId: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  creatorId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  url: z.string().optional(),
  sandboxStatus: z.string().nullable().optional(),
  resources: z
    .strictObject({
      messages: z.string(),
      events: z.string(),
      artifacts: z.string(),
      diff: z.string(),
      pullRequests: z.string(),
      children: z.string(),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type ExternalSession = z.infer<typeof externalSessionSchema>;

export const externalCreateSessionResponseSchema = z.discriminatedUnion("status", [
  z.strictObject({
    sessionId: requiredTextSchema,
    status: z.literal("created"),
    url: z.string().optional(),
  }),
  z.strictObject({
    sessionId: requiredTextSchema,
    messageId: requiredTextSchema,
    status: z.literal("queued"),
    url: z.string().optional(),
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
    message: requiredTextSchema.optional(),
    requestId: requiredTextSchema.optional(),
    details: z.record(z.string(), externalJsonValueSchema).optional(),
    permission: requiredTextSchema.optional(),
  })
  .refine((response) => response.message === undefined || response.error === response.message, {
    message: "error and message must match",
    path: ["message"],
  });

export const externalSessionWaitResponseSchema = z.strictObject({
  sessionId: requiredTextSchema,
  status: sessionStatusSchema,
  settled: z.boolean(),
  timedOut: z.boolean().optional(),
  latestAssistantMessage: z
    .strictObject({ id: z.string(), content: z.string(), completedAt: z.number().nullable() })
    .nullable()
    .optional(),
  artifactIds: z.array(z.string()).optional(),
  pullRequestIds: z.array(z.string()).optional(),
});
