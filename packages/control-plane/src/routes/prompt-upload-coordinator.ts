import type { PromptImageMimeType } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import {
  uploadMutationResultSchema,
  type RecordUploadCommand,
  type UploadCommand,
  type UploadMutationResult,
} from "../session/upload-contracts";
import type { ObjectStorage } from "../storage/object-storage";
import type { SessionRuntimeClient } from "../session/runtime-client";

const MAX_REGISTRATION_ATTEMPTS = 3;

export interface PromptUploadRecord {
  uploadId: string;
  mimeType: PromptImageMimeType;
  sizeBytes: number;
  objectKey: string;
}

export type StorePromptUploadResult = { ok: true } | { ok: false; status: number; error: string };

interface PromptUploadCoordinatorContext {
  requestId?: string;
  traceId?: string;
}

/** Coordinates the fallible R2 + Durable Object upload registration protocol. */
export class PromptUploadCoordinator {
  constructor(
    private readonly runtime: SessionRuntimeClient,
    private readonly storage: ObjectStorage,
    private readonly sessionId: string,
    private readonly log: Logger,
    private readonly context: PromptUploadCoordinatorContext
  ) {}

  async store(bytes: Uint8Array, record: PromptUploadRecord): Promise<StorePromptUploadResult> {
    const result = await this.register(record);
    if (!result.ok) return result;

    // Register first so every failed or ambiguous storage outcome remains
    // discoverable through the normal stale-upload cleanup protocol.
    await this.storage.put(record.objectKey, bytes, { contentType: record.mimeType });
    return { ok: true };
  }

  private async register(record: PromptUploadRecord): Promise<StorePromptUploadResult> {
    const command: RecordUploadCommand = { action: "record", ...record };
    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
      const response = await this.sendCommand(command);
      if (!response.ok) return this.registrationError(response);

      const result = await this.parseMutationResult(response);
      if (!result) {
        return { ok: false, status: 502, error: "Upload registry returned an invalid response" };
      }
      if (result.status === "ok") return { ok: true };

      const cleanup = await this.deleteClaimedObjects(result.staleUploads);
      const completion = await this.sendCommand({
        action: "complete_cleanup",
        cleanupClaimedAt: result.cleanupClaimedAt,
        acknowledgedUploadIds: cleanup.acknowledgedUploadIds,
        releasedUploadIds: cleanup.releasedUploadIds,
      });
      if (!completion.ok) return this.registrationError(completion);
      const completionResult = await this.parseMutationResult(completion);
      if (!completionResult || completionResult.status !== "ok") {
        return { ok: false, status: 502, error: "Upload registry returned an invalid response" };
      }
      if (cleanup.releasedUploadIds.length > 0) {
        return {
          ok: false,
          status: 503,
          error: "Failed to clean up expired uploads; please retry",
        };
      }
    }
    return { ok: false, status: 503, error: "Upload cleanup did not converge; please retry" };
  }

  private sendCommand(command: UploadCommand): Promise<Response> {
    return this.runtime.fetch(this.sessionId, SessionInternalPaths.uploads, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  }

  private async parseMutationResult(response: Response): Promise<UploadMutationResult | null> {
    try {
      const result = uploadMutationResultSchema.safeParse(await response.json());
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async registrationError(response: Response): Promise<StorePromptUploadResult> {
    let message = response.status === 404 ? "Session not found" : "Failed to record upload";
    try {
      const body: unknown = await response.json();
      if (
        body !== null &&
        typeof body === "object" &&
        "error" in body &&
        typeof body.error === "string" &&
        body.error.trim()
      ) {
        message = body.error;
      }
    } catch {
      // Keep the status-based fallback.
    }
    return { ok: false, status: response.status, error: message };
  }

  private async deleteClaimedObjects(
    uploads: Array<{ uploadId: string; objectKey: string }>
  ): Promise<{ acknowledgedUploadIds: string[]; releasedUploadIds: string[] }> {
    const results = await Promise.allSettled(
      uploads.map((upload) => this.storage.delete(upload.objectKey))
    );
    const acknowledgedUploadIds: string[] = [];
    const releasedUploadIds: string[] = [];
    results.forEach((result, index) => {
      const uploadId = uploads[index]?.uploadId;
      if (!uploadId) return;
      if (result.status === "fulfilled") acknowledgedUploadIds.push(uploadId);
      else releasedUploadIds.push(uploadId);
    });
    this.log.info("uploads.pruned_stale_objects", {
      session_id: this.sessionId,
      deleted: acknowledgedUploadIds.length,
      failed: releasedUploadIds.length,
      request_id: this.context.requestId,
      trace_id: this.context.traceId,
    });
    return { acknowledgedUploadIds, releasedUploadIds };
  }
}
