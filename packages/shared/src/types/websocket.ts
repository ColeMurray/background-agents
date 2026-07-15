import { z } from "zod";

export const MAX_PROMPT_ATTACHMENTS = 6;
export const PROMPT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const promptImageMimeTypeSchema = z.enum(PROMPT_IMAGE_MIME_TYPES);
export type PromptImageMimeType = z.infer<typeof promptImageMimeTypeSchema>;
export const promptUploadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/);

/** Client-supplied reference to an image previously uploaded for this session. */
export const promptAttachmentSchema = z
  .object({
    uploadId: promptUploadIdSchema,
    name: z.string().min(1).max(255),
  })
  .strict();

export const promptAttachmentsSchema = z.array(promptAttachmentSchema).max(MAX_PROMPT_ATTACHMENTS);
export type PromptAttachment = z.infer<typeof promptAttachmentSchema>;

/** Server-resolved attachment metadata persisted with messages and events. */
export const resolvedPromptAttachmentSchema = promptAttachmentSchema
  .extend({
    mimeType: promptImageMimeTypeSchema,
  })
  .strict();
export type ResolvedPromptAttachment = z.infer<typeof resolvedPromptAttachmentSchema>;
export const resolvedPromptAttachmentsSchema = z
  .array(resolvedPromptAttachmentSchema)
  .max(MAX_PROMPT_ATTACHMENTS);

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), token: z.string(), clientId: z.string() }),
  z.object({
    type: z.literal("prompt"),
    content: z.string(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
    attachments: promptAttachmentsSchema.optional(),
  }),
  z.object({ type: z.literal("stop") }),
  z.object({ type: z.literal("typing") }),
  z.object({
    type: z.literal("presence"),
    status: z.enum(["active", "idle"]),
    cursor: z.object({ line: z.number(), file: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("fetch_history"),
    cursor: z.object({ timestamp: z.number(), id: z.string() }).optional(),
    limit: z.number().optional(),
  }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
