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

export type SessionAttachmentStorageErrorReason =
  | "session_not_found"
  | "quota_exceeded"
  | "registry_unavailable"
  | "cleanup_failed";

export class SessionAttachmentStorageError extends Error {
  constructor(
    readonly reason: SessionAttachmentStorageErrorReason,
    message: string
  ) {
    super(message);
    this.name = "SessionAttachmentStorageError";
  }
}

/** Coordinates attachment persistence across R2 and the session Durable Object. */
export class SessionAttachmentStorageService {
  constructor(
    private readonly runtime: SessionRuntimeClient,
    private readonly storage: ObjectStorage,
    private readonly sessionId: string,
    private readonly log: Logger
  ) {}

  async store(bytes: Uint8Array, record: SessionAttachmentRecord): Promise<void> {
    await this.register(record);

    // Register first so every failed or ambiguous storage outcome remains
    // discoverable through the normal stale-attachment cleanup protocol.
    await this.storage.put(record.objectKey, bytes, { contentType: record.mimeType });
  }

  private async register(record: SessionAttachmentRecord): Promise<void> {
    const command: RecordAttachmentCommand = {
      action: "record",
      attachmentId: record.attachmentId,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
    };
    for (let attempt = 0; attempt < MAX_REGISTRATION_ATTEMPTS; attempt += 1) {
      const response = await this.sendCommand(command);
      if (!response.ok) await this.throwRegistrationError(response);

      const result = await this.parseMutationResult(response);
      if (result.status === "ok") return;

      const cleanup = await this.deleteClaimedObjects(result.staleAttachments);
      const completion = await this.sendCommand({
        action: "complete_cleanup",
        cleanupClaimedAt: result.cleanupClaimedAt,
        acknowledgedAttachmentIds: cleanup.acknowledgedAttachmentIds,
        releasedAttachmentIds: cleanup.releasedAttachmentIds,
      });
      if (!completion.ok) await this.throwRegistrationError(completion);
      const completionResult = await this.parseMutationResult(completion);
      if (completionResult.status !== "ok") {
        throw new SessionAttachmentStorageError(
          "registry_unavailable",
          "Attachment registry returned an invalid response"
        );
      }
      if (cleanup.releasedAttachmentIds.length > 0) {
        throw new SessionAttachmentStorageError(
          "cleanup_failed",
          "Failed to clean up expired attachments; please retry"
        );
      }
    }
    throw new SessionAttachmentStorageError(
      "cleanup_failed",
      "Attachment cleanup did not converge; please retry"
    );
  }

  private sendCommand(command: SessionAttachmentCommand): Promise<Response> {
    return this.runtime.fetch(this.sessionId, SessionInternalPaths.attachments, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
  }

  private async parseMutationResult(response: Response): Promise<SessionAttachmentMutationResult> {
    try {
      const result = sessionAttachmentMutationResultSchema.safeParse(await response.json());
      if (result.success) return result.data;
    } catch {
      // Use the same domain failure for malformed JSON and invalid payloads.
    }
    throw new SessionAttachmentStorageError(
      "registry_unavailable",
      "Attachment registry returned an invalid response"
    );
  }

  private async throwRegistrationError(response: Response): Promise<never> {
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
    const reason: SessionAttachmentStorageErrorReason =
      response.status === 404
        ? "session_not_found"
        : response.status === 429
          ? "quota_exceeded"
          : "registry_unavailable";
    throw new SessionAttachmentStorageError(reason, message);
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
    });
    return { acknowledgedAttachmentIds, releasedAttachmentIds };
  }
}
