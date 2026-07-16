import type { SessionAttachmentMimeType } from "@open-inspect/shared";
import type { Logger } from "../../logger";
import { SessionInternalPaths } from "../contracts";
import {
  sessionAttachmentMutationResultSchema,
  type RecordAttachmentCommand,
  type SessionAttachmentCommand,
  type SessionAttachmentMutationResult,
} from "../session-attachment-protocol";
import type { ObjectStorage } from "../../storage/object-storage";
import type { SessionRuntimeClient } from "../runtime-client";

const MAX_REGISTRATION_ATTEMPTS = 3;

export interface SessionAttachmentRecord {
  attachmentId: string;
  mimeType: SessionAttachmentMimeType;
  sizeBytes: number;
  objectKey: string;
}

export type StoreSessionAttachmentResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

interface SessionAttachmentStorageContext {
  requestId?: string;
  traceId?: string;
}

/** Coordinates attachment persistence across R2 and the session Durable Object. */
export class SessionAttachmentStorageService {
  constructor(
    private readonly runtime: SessionRuntimeClient,
    private readonly storage: ObjectStorage,
    private readonly sessionId: string,
    private readonly log: Logger,
    private readonly context: SessionAttachmentStorageContext
  ) {}

  async store(
    bytes: Uint8Array,
    record: SessionAttachmentRecord
  ): Promise<StoreSessionAttachmentResult> {
    const result = await this.register(record);
    if (!result.ok) return result;

    // Register first so every failed or ambiguous storage outcome remains
    // discoverable through the normal stale-attachment cleanup protocol.
    await this.storage.put(record.objectKey, bytes, { contentType: record.mimeType });
    return { ok: true };
  }

  private async register(record: SessionAttachmentRecord): Promise<StoreSessionAttachmentResult> {
    const command: RecordAttachmentCommand = { action: "record", ...record };
    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
      const response = await this.sendCommand(command);
      if (!response.ok) return this.registrationError(response);

      const result = await this.parseMutationResult(response);
      if (!result) {
        return {
          ok: false,
          status: 502,
          error: "Attachment registry returned an invalid response",
        };
      }
      if (result.status === "ok") return { ok: true };

      const cleanup = await this.deleteClaimedObjects(result.staleAttachments);
      const completion = await this.sendCommand({
        action: "complete_cleanup",
        cleanupClaimedAt: result.cleanupClaimedAt,
        acknowledgedAttachmentIds: cleanup.acknowledgedAttachmentIds,
        releasedAttachmentIds: cleanup.releasedAttachmentIds,
      });
      if (!completion.ok) return this.registrationError(completion);
      const completionResult = await this.parseMutationResult(completion);
      if (!completionResult || completionResult.status !== "ok") {
        return {
          ok: false,
          status: 502,
          error: "Attachment registry returned an invalid response",
        };
      }
      if (cleanup.releasedAttachmentIds.length > 0) {
        return {
          ok: false,
          status: 503,
          error: "Failed to clean up expired attachments; please retry",
        };
      }
    }
    return { ok: false, status: 503, error: "Attachment cleanup did not converge; please retry" };
  }

  private sendCommand(command: SessionAttachmentCommand): Promise<Response> {
    return this.runtime.fetch(this.sessionId, SessionInternalPaths.attachments, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  }

  private async parseMutationResult(
    response: Response
  ): Promise<SessionAttachmentMutationResult | null> {
    try {
      const result = sessionAttachmentMutationResultSchema.safeParse(await response.json());
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async registrationError(response: Response): Promise<StoreSessionAttachmentResult> {
    let message = response.status === 404 ? "Session not found" : "Failed to record attachment";
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
    attachments: Array<{ attachmentId: string; objectKey: string }>
  ): Promise<{ acknowledgedAttachmentIds: string[]; releasedAttachmentIds: string[] }> {
    const results = await Promise.allSettled(
      attachments.map((attachment) => this.storage.delete(attachment.objectKey))
    );
    const acknowledgedAttachmentIds: string[] = [];
    const releasedAttachmentIds: string[] = [];
    results.forEach((result, index) => {
      const attachmentId = attachments[index]?.attachmentId;
      if (!attachmentId) return;
      if (result.status === "fulfilled") acknowledgedAttachmentIds.push(attachmentId);
      else releasedAttachmentIds.push(attachmentId);
    });
    this.log.info("attachments.pruned_stale_objects", {
      session_id: this.sessionId,
      deleted: acknowledgedAttachmentIds.length,
      failed: releasedAttachmentIds.length,
      request_id: this.context.requestId,
      trace_id: this.context.traceId,
    });
    return { acknowledgedAttachmentIds, releasedAttachmentIds };
  }
}
