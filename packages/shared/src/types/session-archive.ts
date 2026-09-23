import { z } from "zod";

/** Maximum number of explicitly selected sessions in one archive request. */
export const MAX_SESSION_ARCHIVE_BATCH_SIZE = 25;

export const sessionBatchArchiveRequestSchema = z.strictObject({
  sessionIds: z
    .array(z.string().trim().min(1).max(256))
    .min(1)
    .max(MAX_SESSION_ARCHIVE_BATCH_SIZE)
    .refine((ids) => new Set(ids).size === ids.length, "Session IDs must be unique"),
});

export type SessionBatchArchiveRequest = z.infer<typeof sessionBatchArchiveRequestSchema>;

/** Outcomes decided by the session that owns the lifecycle state. */
export const sessionArchiveOutcomeSchema = z.enum([
  "archived",
  "already_archived",
  "skipped_cancelled",
  "skipped_queued_work",
]);

export type SessionArchiveOutcome = z.infer<typeof sessionArchiveOutcomeSchema>;

export const SESSION_ARCHIVE_HTTP_STATUS = {
  archived: 200,
  already_archived: 200,
  skipped_cancelled: 409,
  skipped_queued_work: 409,
} as const satisfies Record<SessionArchiveOutcome, number>;

/** The single-session endpoint also retains its existing status/error fields. */
export const sessionArchiveResponseSchema = z.object({ outcome: sessionArchiveOutcomeSchema });

export const sessionBatchArchiveResultSchema = z.strictObject({
  sessionId: z.string(),
  outcome: z.enum([...sessionArchiveOutcomeSchema.options, "not_found", "failed"]),
});

export type SessionBatchArchiveResult = z.infer<typeof sessionBatchArchiveResultSchema>;

export const sessionBatchArchiveResponseSchema = z.strictObject({
  results: z.array(sessionBatchArchiveResultSchema),
});

export type SessionBatchArchiveResponse = z.infer<typeof sessionBatchArchiveResponseSchema>;
