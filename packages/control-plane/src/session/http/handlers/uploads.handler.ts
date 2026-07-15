import type { Logger } from "../../../logger";
import {
  PROMPT_UPLOAD_LIMIT_PER_SESSION,
  PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION,
  PROMPT_UPLOAD_UNREFERENCED_TTL_MS,
  PROMPT_UPLOAD_CLEANUP_CLAIM_TTL_MS,
} from "../../../media";
import type { SessionRepository } from "../../repository";
import type { SessionRow } from "../../types";
import { uploadCommandSchema } from "../../upload-contracts";

export interface UploadsHandlerDeps {
  repository: Pick<
    SessionRepository,
    | "createUpload"
    | "getUploadTotals"
    | "claimStaleUnreferencedUploads"
    | "acknowledgeUploadCleanup"
    | "releaseUploadCleanupClaims"
  >;
  getSession: () => SessionRow | null;
  getLog: () => Logger;
  now?: () => number;
}

export interface UploadsHandler {
  recordUpload: (request: Request) => Promise<Response>;
}

/**
 * Records a prompt upload so it is a tracked session resource: per-session
 * quotas are enforced here (the DO is single-threaded, so concurrent uploads
 * cannot race past the caps), and each call sweeps upload records that were
 * never referenced by a prompt within the TTL, returning their object keys so
 * the caller can delete the R2 objects.
 */
export function createUploadsHandler(deps: UploadsHandlerDeps): UploadsHandler {
  const now = deps.now ?? (() => Date.now());

  return {
    async recordUpload(request: Request): Promise<Response> {
      if (!deps.getSession()) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return Response.json({ error: "Invalid request body" }, { status: 400 });
      }
      const command = uploadCommandSchema.safeParse(raw);
      if (!command.success) {
        return Response.json({ error: "Invalid upload command" }, { status: 400 });
      }
      if (command.data.action === "complete_cleanup") {
        deps.repository.acknowledgeUploadCleanup(command.data.acknowledgedUploadIds);
        deps.repository.releaseUploadCleanupClaims(command.data.releasedUploadIds);
        return Response.json({ status: "ok" });
      }
      const record = command.data;

      const timestamp = now();
      const stale = deps.repository.claimStaleUnreferencedUploads(
        timestamp - PROMPT_UPLOAD_UNREFERENCED_TTL_MS,
        timestamp,
        timestamp - PROMPT_UPLOAD_CLEANUP_CLAIM_TTL_MS
      );
      if (stale.length > 0) {
        deps.getLog().info("uploads.claimed_stale", {
          count: stale.length,
          total_bytes: stale.reduce((sum, upload) => sum + upload.size_bytes, 0),
        });
        return Response.json({
          status: "cleanup_required",
          staleUploads: stale.map((upload) => ({
            uploadId: upload.id,
            objectKey: upload.object_key,
          })),
        });
      }

      const totals = deps.repository.getUploadTotals();
      if (totals.count >= PROMPT_UPLOAD_LIMIT_PER_SESSION) {
        return Response.json(
          { error: `Session upload limit of ${PROMPT_UPLOAD_LIMIT_PER_SESSION} files exceeded` },
          { status: 429 }
        );
      }
      if (totals.totalBytes + record.sizeBytes > PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION) {
        return Response.json({ error: "Session upload storage limit exceeded" }, { status: 429 });
      }

      deps.repository.createUpload({
        id: record.uploadId,
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
