import { z } from "zod";

export const MAX_SESSION_ATTACHMENTS_PER_MESSAGE = 6;
export const SESSION_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const sessionAttachmentMimeTypeSchema = z.enum(SESSION_ATTACHMENT_IMAGE_MIME_TYPES);
export type SessionAttachmentMimeType = z.infer<typeof sessionAttachmentMimeTypeSchema>;

export const sessionAttachmentIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9-]+$/);

/** Client-supplied reference to an image previously uploaded for this session. */
export const sessionAttachmentReferenceSchema = z
  .object({
    attachmentId: sessionAttachmentIdSchema,
    name: z.string().min(1).max(255),
  })
  .strict();

export const sessionAttachmentReferencesSchema = z
  .array(sessionAttachmentReferenceSchema)
  .max(MAX_SESSION_ATTACHMENTS_PER_MESSAGE);
export type SessionAttachmentReference = z.infer<typeof sessionAttachmentReferenceSchema>;

/** Server-resolved attachment metadata persisted with messages and events. */
export const resolvedSessionAttachmentSchema = sessionAttachmentReferenceSchema
  .extend({
    mimeType: sessionAttachmentMimeTypeSchema,
  })
  .strict();
export type ResolvedSessionAttachment = z.infer<typeof resolvedSessionAttachmentSchema>;

export const resolvedSessionAttachmentsSchema = z
  .array(resolvedSessionAttachmentSchema)
  .max(MAX_SESSION_ATTACHMENTS_PER_MESSAGE);
