import type { Logger } from "../../../logger";
import {
  PROMPT_UPLOAD_LIMIT_PER_SESSION,
  PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION,
  PROMPT_UPLOAD_UNREFERENCED_TTL_MS,
  PROMPT_UPLOAD_CLEANUP_CLAIM_TTL_MS,
} from "../../../media";
import type { SessionRepository } from "../../repository";
import type { SessionRow } from "../../types";

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

interface RecordUploadBody {
  action?: "record";
  uploadId: string;
  kind: "image";
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
}

interface CompleteCleanupBody {
  action: "complete_cleanup";
  acknowledgedUploadIds: string[];
  releasedUploadIds: string[];
}

function isValidBody(raw: unknown): raw is RecordUploadBody {
  if (!raw || typeof raw !== "object") return false;
  const body = raw as Partial<RecordUploadBody>;
  return (
    typeof body.uploadId === "string" &&
    body.uploadId.length > 0 &&
    body.kind === "image" &&
    typeof body.mimeType === "string" &&
    body.mimeType.length > 0 &&
    typeof body.sizeBytes === "number" &&
    Number.isSafeInteger(body.sizeBytes) &&
    body.sizeBytes > 0 &&
    typeof body.objectKey === "string" &&
    body.objectKey.length > 0
  );
}

function isCompleteCleanupBody(raw: unknown): raw is CompleteCleanupBody {
  if (!raw || typeof raw !== "object") return false;
  const body = raw as Partial<CompleteCleanupBody>;
  return (
    body.action === "complete_cleanup" &&
    Array.isArray(body.acknowledgedUploadIds) &&
    body.acknowledgedUploadIds.every((id) => typeof id === "string" && id.length > 0) &&
    Array.isArray(body.releasedUploadIds) &&
    body.releasedUploadIds.every((id) => typeof id === "string" && id.length > 0)
  );
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
      if (isCompleteCleanupBody(raw)) {
        deps.repository.acknowledgeUploadCleanup(raw.acknowledgedUploadIds);
        deps.repository.releaseUploadCleanupClaims(raw.releasedUploadIds);
        return Response.json({ status: "ok" });
      }
      if (!isValidBody(raw)) {
        return Response.json({ error: "Invalid upload record body" }, { status: 400 });
      }

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
      if (totals.totalBytes + raw.sizeBytes > PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION) {
        return Response.json({ error: "Session upload storage limit exceeded" }, { status: 429 });
      }

      deps.repository.createUpload({
        id: raw.uploadId,
        kind: raw.kind,
        mimeType: raw.mimeType,
        sizeBytes: raw.sizeBytes,
        objectKey: raw.objectKey,
        createdAt: timestamp,
      });

      return Response.json({
        status: "ok",
      });
    },
  };
}
