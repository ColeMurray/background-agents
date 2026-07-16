import { promptImageMimeTypeSchema, promptUploadIdSchema } from "@open-inspect/shared";
import { z } from "zod";
import { PROMPT_UPLOAD_IMAGE_MAX_BYTES } from "../media";

const objectKeySchema = z.string().min(1).max(1024);

export const recordUploadCommandSchema = z
  .object({
    action: z.literal("record"),
    uploadId: promptUploadIdSchema,
    mimeType: promptImageMimeTypeSchema,
    sizeBytes: z.number().int().positive().max(PROMPT_UPLOAD_IMAGE_MAX_BYTES),
    objectKey: objectKeySchema,
  })
  .strict();

export const completeUploadCleanupCommandSchema = z
  .object({
    action: z.literal("complete_cleanup"),
    cleanupClaimedAt: z.number().int().nonnegative(),
    acknowledgedUploadIds: z.array(promptUploadIdSchema),
    releasedUploadIds: z.array(promptUploadIdSchema),
  })
  .strict();

export const uploadCommandSchema = z.discriminatedUnion("action", [
  recordUploadCommandSchema,
  completeUploadCleanupCommandSchema,
]);
export type UploadCommand = z.infer<typeof uploadCommandSchema>;
export type RecordUploadCommand = z.infer<typeof recordUploadCommandSchema>;

export const uploadMutationResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }).strict(),
  z
    .object({
      status: z.literal("cleanup_required"),
      cleanupClaimedAt: z.number().int().nonnegative(),
      staleUploads: z.array(
        z
          .object({
            uploadId: promptUploadIdSchema,
            objectKey: objectKeySchema,
          })
          .strict()
      ),
    })
    .strict(),
]);
export type UploadMutationResult = z.infer<typeof uploadMutationResultSchema>;
