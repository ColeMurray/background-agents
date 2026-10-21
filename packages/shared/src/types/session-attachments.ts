import { z } from "zod";

export const MAX_SESSION_ATTACHMENTS_PER_MESSAGE = 6;
/** Per-image byte cap, enforced by the attachment store and every producer. */
export const SESSION_ATTACHMENT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/**
 * The largest total of image bytes one Pi Durable turn may carry.
 *
 * The Pi runtime keeps a turn's user message as one Durable Object SQLite
 * row, and a SQLite-backed Durable Object caps a row at 2 MB. A turn's images
 * ride base64-encoded inside that row, so the images of one turn must fit in
 * a fraction of it: 1 MiB of images is about 1.4 MB of base64, which leaves
 * room for the prompt text and the record's own fields. A turn over the limit
 * is refused by the session rather than handed to a runtime that cannot
 * store it.
 */
export const PI_ATTACHMENT_MAX_TURN_BYTES = 1024 * 1024;
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
