import { z } from "zod";

export const MAX_SESSION_ATTACHMENTS_PER_MESSAGE = 6;
/** Per-image byte cap, enforced by the attachment store and every producer. */
export const SESSION_ATTACHMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
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

/**
 * Body of a successful upload to `POST /sessions/:id/attachments`, parsed by
 * every client that turns an upload into a prompt reference. The id is the
 * canonical one, so an id that the prompt schema would reject is treated as a
 * failed upload where it arrives rather than being carried into client state
 * and failing later at prompt validation. Unknown keys are ignored so the
 * endpoint can add response fields without breaking deployed clients.
 */
export const sessionAttachmentUploadResponseSchema = z.object({
  attachmentId: sessionAttachmentIdSchema,
  mimeType: sessionAttachmentMimeTypeSchema,
});
export type SessionAttachmentUploadResponse = z.infer<typeof sessionAttachmentUploadResponseSchema>;
