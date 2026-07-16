import { sessionAttachmentMimeTypeSchema, sessionAttachmentIdSchema } from "@open-inspect/shared";
import { z } from "zod";
import { SESSION_ATTACHMENT_IMAGE_MAX_BYTES } from "../media";

const objectKeySchema = z.string().min(1).max(1024);

export const recordAttachmentCommandSchema = z
  .object({
    action: z.literal("record"),
    attachmentId: sessionAttachmentIdSchema,
    mimeType: sessionAttachmentMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(SESSION_ATTACHMENT_IMAGE_MAX_BYTES),
  })
  .strict();

export const completeAttachmentCleanupCommandSchema = z
  .object({
    action: z.literal("complete_cleanup"),
    cleanupClaimedAt: z.number().int().nonnegative(),
    acknowledgedAttachmentIds: z.array(sessionAttachmentIdSchema),
    releasedAttachmentIds: z.array(sessionAttachmentIdSchema),
  })
  .strict();

export const sessionAttachmentCommandSchema = z.discriminatedUnion("action", [
  recordAttachmentCommandSchema,
  completeAttachmentCleanupCommandSchema,
]);
export type SessionAttachmentCommand = z.infer<typeof sessionAttachmentCommandSchema>;
export type RecordAttachmentCommand = z.infer<typeof recordAttachmentCommandSchema>;

export const sessionAttachmentMutationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  z
    .object({
      status: z.literal("cleanup_required"),
      cleanupClaimedAt: z.number().int().nonnegative(),
      staleAttachments: z.array(
        z
          .object({
            attachmentId: sessionAttachmentIdSchema,
            objectKey: objectKeySchema,
          })
          .strict()
      ),
    })
    .strict(),
]);
export type SessionAttachmentMutationResult = z.infer<typeof sessionAttachmentMutationResultSchema>;
