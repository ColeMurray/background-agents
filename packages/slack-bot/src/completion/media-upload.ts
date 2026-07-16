import {
  buildInternalAuthHeaders,
  completeExternalUpload,
  getExternalUploadUrl,
  uploadToExternalUrl,
  type MediaArtifactInfo,
} from "@open-inspect/shared";
import type { Env } from "../types";
import { createLogger } from "../logger";

export const SLACK_MEDIA_MAX_FILES_PER_COMPLETION = 5;
export const SLACK_MEDIA_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SLACK_MEDIA_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const UPLOAD_CLAIM_TTL_SECONDS = 10 * 60;
const UPLOADED_MARKER_TTL_SECONDS = 7 * 24 * 60 * 60;
const ALT_TEXT_LIMIT = 1_000;
const log = createLogger("completion-media");

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "video/mp4": "mp4",
};

export interface MediaDeliveryResult {
  uploaded: number;
  failed: number;
  skipped: number;
}

interface DeliverMediaArtifactsInput {
  env: Env;
  sessionId: string;
  messageId: string;
  channel: string;
  threadTs: string;
  artifacts: MediaArtifactInfo[];
  traceId?: string;
}

export async function deliverMediaArtifacts(
  input: DeliverMediaArtifactsInput
): Promise<MediaDeliveryResult> {
  const selected = input.artifacts.slice(0, SLACK_MEDIA_MAX_FILES_PER_COMPLETION);
  const result: MediaDeliveryResult = {
    uploaded: 0,
    failed: 0,
    skipped: input.artifacts.length - selected.length,
  };
  let deliveredBytes = 0;

  for (const artifact of selected) {
    const key = `completion-media:v1:${input.sessionId}:${input.messageId}:${artifact.id}`;
    let existingMarker: string | null = null;
    try {
      existingMarker = await input.env.SLACK_KV.get(key);
    } catch (error) {
      log.warn("slack.media.idempotency", {
        artifact_id: artifact.id,
        outcome: "error",
        error: error instanceof Error ? error : String(error),
      });
    }
    if (existingMarker) {
      result.skipped += 1;
      continue;
    }

    if (
      artifact.sizeBytes !== undefined &&
      (artifact.sizeBytes > SLACK_MEDIA_MAX_FILE_BYTES ||
        deliveredBytes + artifact.sizeBytes > SLACK_MEDIA_MAX_TOTAL_BYTES)
    ) {
      result.skipped += 1;
      continue;
    }

    try {
      await input.env.SLACK_KV.put(key, "uploading", { expirationTtl: UPLOAD_CLAIM_TTL_SECONDS });
    } catch (error) {
      log.warn("slack.media.idempotency", {
        artifact_id: artifact.id,
        outcome: "error",
        error: error instanceof Error ? error : String(error),
      });
    }

    let delivery: Awaited<ReturnType<typeof deliverOne>>;
    try {
      delivery = await deliverOne(input, artifact, deliveredBytes);
    } catch (error) {
      log.warn("slack.media.delivery", {
        artifact_id: artifact.id,
        outcome: "error",
        error: error instanceof Error ? error : String(error),
      });
      delivery = { ok: false };
    }
    if (!delivery.ok) {
      result[delivery.skipped ? "skipped" : "failed"] += 1;
      try {
        await input.env.SLACK_KV.delete(key);
      } catch {
        // The short claim TTL allows a later callback to retry.
      }
      continue;
    }

    deliveredBytes += delivery.sizeBytes;
    result.uploaded += 1;
    try {
      await input.env.SLACK_KV.put(key, "uploaded", {
        expirationTtl: UPLOADED_MARKER_TTL_SECONDS,
      });
    } catch (error) {
      log.warn("slack.media.idempotency", {
        artifact_id: artifact.id,
        outcome: "error",
        error: error instanceof Error ? error : String(error),
      });
    }
  }

  return result;
}

async function deliverOne(
  input: DeliverMediaArtifactsInput,
  artifact: MediaArtifactInfo,
  deliveredBytes: number
): Promise<{ ok: true; sizeBytes: number } | { ok: false; skipped?: boolean }> {
  const base = {
    trace_id: input.traceId,
    session_id: input.sessionId,
    message_id: input.messageId,
    artifact_id: artifact.id,
    artifact_type: artifact.type,
  };
  const headers = await buildInternalAuthHeaders(input.env.INTERNAL_CALLBACK_SECRET, input.traceId);
  const response = await input.env.CONTROL_PLANE.fetch(
    `https://internal/sessions/${encodeURIComponent(input.sessionId)}/media/${encodeURIComponent(artifact.id)}`,
    { headers }
  );
  if (!response.ok || !response.body) {
    log.warn("slack.media.fetch", { ...base, outcome: "error", http_status: response.status });
    return { ok: false };
  }

  const mimeType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ?? "";
  const extension = EXTENSIONS[mimeType];
  const sizeBytes = Number(response.headers.get("Content-Length"));
  if (!extension || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    log.warn("slack.media.fetch", { ...base, outcome: "error", error: "invalid_media_headers" });
    return { ok: false };
  }
  if (
    sizeBytes > SLACK_MEDIA_MAX_FILE_BYTES ||
    deliveredBytes + sizeBytes > SLACK_MEDIA_MAX_TOTAL_BYTES
  ) {
    log.info("slack.media.delivery", { ...base, outcome: "skipped", size_bytes: sizeBytes });
    return { ok: false, skipped: true };
  }

  const title = artifact.caption?.trim() || `${artifact.type} ${artifact.id}`;
  const ticket = await getExternalUploadUrl(input.env.SLACK_BOT_TOKEN, {
    filename: `artifact-${artifact.id}.${extension}`,
    length: sizeBytes,
    altText: title.slice(0, ALT_TEXT_LIMIT),
  });
  if (!ticket.ok) {
    log.warn("slack.media.get_upload_url", {
      ...base,
      outcome: "error",
      slack_error: ticket.error,
    });
    return { ok: false };
  }

  const upload = await uploadToExternalUrl(ticket.upload_url, response.body, mimeType);
  if (!upload.ok) {
    log.warn("slack.media.upload_bytes", { ...base, outcome: "error", slack_error: upload.error });
    return { ok: false };
  }

  const complete = await completeExternalUpload(input.env.SLACK_BOT_TOKEN, {
    fileId: ticket.file_id,
    title,
    channelId: input.channel,
    threadTs: input.threadTs,
  });
  if (!complete.ok) {
    log.warn("slack.media.complete_upload", {
      ...base,
      outcome: "error",
      slack_error: complete.error,
    });
    return { ok: false };
  }

  log.info("slack.media.delivery", {
    ...base,
    outcome: "success",
    size_bytes: sizeBytes,
    slack_file_id: ticket.file_id,
  });
  return { ok: true, sizeBytes };
}
