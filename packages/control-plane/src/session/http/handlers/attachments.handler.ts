import type { Logger } from "../../../logger";
import {
  SESSION_ATTACHMENT_LIMIT_PER_SESSION,
  SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION,
  SESSION_ATTACHMENT_UNREFERENCED_TTL_MS,
  SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS,
} from "../../../media";
import type { SessionAttachmentRepository } from "../../session-attachment-repository";
import type { SessionRow } from "../../types";
import { sessionAttachmentCommandSchema } from "../../session-attachment-contracts";

export interface AttachmentsHandlerDeps {
  repository: Pick<
    SessionAttachmentRepository,
    "create" | "getTotals" | "claimStale" | "acknowledgeCleanup" | "releaseCleanupClaims"
  >;
  getSession: () => SessionRow | null;
  getLog: () => Logger;
  now?: () => number;
}

export interface AttachmentsHandler {
  recordAttachment: (request: Request) => Promise<Response>;
}

/**
 * Records a session attachment so it is a tracked session resource: per-session
 * quotas are enforced here (the DO is single-threaded, so concurrent registrations
 * cannot race past the caps), and each call sweeps attachment records that were
 * never referenced by a message within the TTL, returning their object keys so
 * the caller can delete the R2 objects.
 */
export function createAttachmentsHandler(deps: AttachmentsHandlerDeps): AttachmentsHandler {
  const now = deps.now ?? (() => Date.now());

  return {
    async recordAttachment(request: Request): Promise<Response> {
      if (!deps.getSession()) {
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
        deps.repository.acknowledgeCleanup(
          command.data.acknowledgedAttachmentIds,
          command.data.cleanupClaimedAt
        );
        deps.repository.releaseCleanupClaims(
          command.data.releasedAttachmentIds,
          command.data.cleanupClaimedAt
        );
        return Response.json({ status: "ok" });
      }
      const record = command.data;

      const timestamp = now();
      const stale = deps.repository.claimStale(
        timestamp - SESSION_ATTACHMENT_UNREFERENCED_TTL_MS,
        timestamp,
        timestamp - SESSION_ATTACHMENT_CLEANUP_CLAIM_TTL_MS
      );
      if (stale.length > 0) {
        deps.getLog().info("attachments.claimed_stale", {
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

      const totals = deps.repository.getTotals();
      if (totals.count >= SESSION_ATTACHMENT_LIMIT_PER_SESSION) {
        return Response.json(
          {
            error: `Session attachment limit of ${SESSION_ATTACHMENT_LIMIT_PER_SESSION} files exceeded`,
          },
          { status: 429 }
        );
      }
      if (totals.totalBytes + record.sizeBytes > SESSION_ATTACHMENT_TOTAL_BYTES_PER_SESSION) {
        return Response.json(
          { error: "Session attachment storage limit exceeded" },
          { status: 429 }
        );
      }

      deps.repository.create({
        id: record.attachmentId,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        objectKey: record.objectKey,
        createdAt: timestamp,
      });

      return Response.json({
        status: "ok",
      });
    },
  };
}
