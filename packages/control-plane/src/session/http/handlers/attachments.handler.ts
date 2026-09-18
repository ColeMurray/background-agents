import type { Logger } from "../../../logger";
import {
  buildSessionAttachmentObjectKey,
  SESSION_ATTACHMENT_LIMIT_PER_SESSION,
  SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION,
  SESSION_ATTACHMENT_UNREFERENCED_TTL_MS,
  SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS,
} from "../../../media";
import type { SessionAttachmentRepository } from "../../session-attachment-repository";
import { sessionAttachmentCommandSchema } from "../../session-attachment-protocol";

/**
 * Records a session attachment so it is a tracked session resource: per-session
 * quotas are enforced here (the DO is single-threaded, so concurrent registrations
 * cannot race past the caps), and each call sweeps attachment records that were
 * never referenced by a message within the TTL, returning their object keys so
 * the caller can delete the R2 objects.
 */
export class AttachmentsHandler {
  constructor(
    private readonly repository: SessionAttachmentRepository,
    private readonly log: Logger,
    private readonly now: () => number = Date.now
  ) {}

  async recordAttachment(request: Request, sessionId: string | null): Promise<Response> {
    if (!sessionId) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
    const command = sessionAttachmentCommandSchema.safeParse(raw);
    if (!command.success) {
      return Response.json({ error: "Invalid attachment command" }, { status: 400 });
    }
    if (command.data.action === "complete_cleanup") {
      this.repository.acknowledgeCleanup(
        command.data.acknowledgedAttachmentIds,
        command.data.cleanupClaimedAt
      );
      this.repository.releaseCleanupClaims(
        command.data.releasedAttachmentIds,
        command.data.cleanupClaimedAt
      );
      return Response.json({ status: "ok" });
    }
    const record = command.data;

    const timestamp = this.now();
    const objectKey = buildSessionAttachmentObjectKey(sessionId, record.attachmentId);
    const existing = this.repository.getById(record.attachmentId);
    if (existing) {
      if (
        existing.cleanup_claimed_at !== null &&
        existing.cleanup_claimed_at >= timestamp - SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS
      ) {
        return Response.json({ error: "Attachment cleanup is in progress" }, { status: 409 });
      }
      if (
        existing.cleanup_claimed_at === null &&
        (existing.mime_type !== record.mimeType ||
          existing.size_bytes !== record.sizeBytes ||
          existing.object_key !== objectKey)
      ) {
        return Response.json({ error: "Attachment ID is already registered" }, { status: 409 });
      }
      if (existing.cleanup_claimed_at === null) return Response.json({ status: "ok" });
    }

    const stale = this.repository.claimStale(
      timestamp - SESSION_ATTACHMENT_UNREFERENCED_TTL_MS,
      timestamp,
      timestamp - SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS
    );
    if (stale.length > 0) {
      this.log.info("attachments.claimed_stale", {
        count: stale.length,
        total_bytes: stale.reduce((sum, attachment) => sum + attachment.size_bytes, 0),
      });
      return Response.json({
        status: "cleanup_required",
        cleanupClaimedAt: timestamp,
        staleAttachments: stale.map((attachment) => ({
          attachmentId: attachment.id,
          objectKey: attachment.object_key,
        })),
      });
    }

    const totals = this.repository.getTotals();
    if (totals.count >= SESSION_ATTACHMENT_LIMIT_PER_SESSION) {
      return Response.json(
        {
          error: `Session attachment limit of ${SESSION_ATTACHMENT_LIMIT_PER_SESSION} files exceeded`,
        },
        { status: 429 }
      );
    }
    if (totals.totalBytes + record.sizeBytes > SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION) {
      return Response.json({ error: "Session attachment storage limit exceeded" }, { status: 429 });
    }

    this.repository.create({
      id: record.attachmentId,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      objectKey,
      createdAt: timestamp,
    });

    return Response.json({
      status: "ok",
    });
  }
}
