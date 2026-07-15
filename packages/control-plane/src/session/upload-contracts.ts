import { promptImageMimeTypeSchema, promptUploadIdSchema } from "@open-inspect/shared";
import { z } from "zod";

const objectKeySchema = z.string().min(1).max(1024);

export const recordUploadCommandSchema = z
  .object({
    action: z.literal("record"),
    uploadId: promptUploadIdSchema,
    mimeType: promptImageMimeTypeSchema,
    sizeBytes: z.number().int().positive(),
    objectKey: objectKeySchema,
  })
  .strict();

export const completeUploadCleanupCommandSchema = z
  .object({
    action: z.literal("complete_cleanup"),
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
