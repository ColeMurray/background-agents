import { z } from "zod";
import { sessionAttachmentRowSchema, type SessionAttachmentRow } from "./types";
import type { SqlStorage } from "./sql-storage";

const attachmentTotalsRowSchema = z.object({
  count: z.number().int().nonnegative(),
  total_bytes: z.number().finite().nonnegative(),
});

export interface CreateSessionAttachmentData {
  id: string;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
  createdAt: number;
}

function parseSessionAttachmentRows(rows: unknown[]): SessionAttachmentRow[] {
  return rows.flatMap((row) => {
    const result = sessionAttachmentRowSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}

export class AttachmentClaimConflictError extends Error {}

/** Persistence for user-provided attachments scoped to one session. */
export class SessionAttachmentRepository {
  constructor(private readonly sql: SqlStorage) {}

  create(data: CreateSessionAttachmentData): void {
    this.sql.exec(
      `INSERT INTO attachments (id, mime_type, size_bytes, object_key, message_id, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
      data.id,
      data.mimeType,
      data.sizeBytes,
      data.objectKey,
      data.createdAt
    );
  }

  getTotals(): { count: number; totalBytes: number } {
    const result = this.sql.exec(
      `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_bytes
       FROM attachments`
    );
    const parsed = attachmentTotalsRowSchema.safeParse(result.toArray()[0]);
    return parsed.success
      ? { count: parsed.data.count, totalBytes: parsed.data.total_bytes }
      : { count: 0, totalBytes: 0 };
  }

  getUnreferenced(attachmentIds: string[]): SessionAttachmentRow[] {
    if (attachmentIds.length === 0) return [];
    const placeholders = attachmentIds.map(() => "?").join(", ");
    const result = this.sql.exec(
      `SELECT * FROM attachments
       WHERE id IN (${placeholders}) AND message_id IS NULL AND cleanup_claimed_at IS NULL`,
      ...attachmentIds
    );
    return parseSessionAttachmentRows(result.toArray());
  }

  claimForMessage(messageId: string, attachmentIds: string[]): void {
    if (attachmentIds.length === 0) return;
    const placeholders = attachmentIds.map(() => "?").join(", ");
    const claimed = this.sql.exec(
      `UPDATE attachments SET message_id = ?
       WHERE id IN (${placeholders}) AND message_id IS NULL AND cleanup_claimed_at IS NULL`,
      messageId,
      ...attachmentIds
    );
    claimed.toArray();
    if (claimed.rowsWritten !== attachmentIds.length) {
      throw new AttachmentClaimConflictError("One or more attachments could not be claimed");
    }
  }

  releaseForMessage(messageId: string): void {
    this.sql.exec(`UPDATE attachments SET message_id = NULL WHERE message_id = ?`, messageId);
  }

  /** Claim stale records without losing ownership before fallible object deletion. */
  claimStale(
    cutoff: number,
    claimedAt: number,
    claimExpiredBefore: number
  ): SessionAttachmentRow[] {
    const result = this.sql.exec(
      `SELECT * FROM attachments
       WHERE message_id IS NULL AND created_at < ?
         AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at < ?)`,
      cutoff,
      claimExpiredBefore
    );
    const stale = parseSessionAttachmentRows(result.toArray());
    if (stale.length === 0) return [];
    const placeholders = stale.map(() => "?").join(", ");
    this.sql.exec(
      `UPDATE attachments SET cleanup_claimed_at = ? WHERE id IN (${placeholders})`,
      claimedAt,
      ...stale.map((attachment) => attachment.id)
    );
    return stale.map((attachment) => ({ ...attachment, cleanup_claimed_at: claimedAt }));
  }

  acknowledgeCleanup(attachmentIds: string[], claimedAt: number): void {
    if (attachmentIds.length === 0) return;
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.sql.exec(
      `DELETE FROM attachments
       WHERE id IN (${placeholders}) AND cleanup_claimed_at = ? AND message_id IS NULL`,
      ...attachmentIds,
      claimedAt
    );
  }

  releaseCleanupClaims(attachmentIds: string[], claimedAt: number): void {
    if (attachmentIds.length === 0) return;
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.sql.exec(
      `UPDATE attachments SET cleanup_claimed_at = NULL
       WHERE id IN (${placeholders}) AND message_id IS NULL AND cleanup_claimed_at = ?`,
      ...attachmentIds,
      claimedAt
    );
  }
}
