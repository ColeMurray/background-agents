import {
  completeExternalUpload,
  getExternalUploadUrl,
  uploadToExternalUrl,
} from "@open-inspect/shared/slack";
import type { MediaArtifactInfo } from "@open-inspect/shared/types/artifacts";
import { ProtectedReadError } from "@open-inspect/shared/completion/extractor";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import type { Env } from "../types";
import { signedControlPlaneFetch } from "../internal-auth";
import { createLogger } from "../logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "../request-options";
import { checkPublicationAccess } from "../sessions/control-plane-client";
import { isThreadSessionClosed } from "../sessions/thread-session-store";

export const SLACK_MEDIA_MAX_FILES_PER_COMPLETION = 5;
export const SLACK_MEDIA_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SLACK_MEDIA_MAX_TOTAL_BYTES = 25 * 1024 * 1024;

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
  omitted: number;
}

interface DeliverMediaArtifactsInput {
  env: Env;
  sessionId: string;
  messageId: string;
  channel: string;
  threadTs: string;
  artifacts: MediaArtifactInfo[];
  traceId?: string;
  /** Called before sharing files, even if Slack's response is lost or unsuccessful. */
  onShareAttempt: () => void;
}

type StagedFile = { id: string; title: string };
type StageResult =
  | { kind: "staged"; sizeBytes: number; file: StagedFile }
  | { kind: "failed"; sizeBytes?: number }
  | { kind: "omitted" };

export async function deliverMediaArtifacts(
  input: DeliverMediaArtifactsInput
): Promise<MediaDeliveryResult> {
  const uniqueArtifacts = [
    ...new Map(input.artifacts.map((artifact) => [artifact.id, artifact])).values(),
  ];
  const selected = uniqueArtifacts.slice(0, SLACK_MEDIA_MAX_FILES_PER_COMPLETION);
  const result: MediaDeliveryResult = {
    uploaded: 0,
    failed: 0,
    omitted: uniqueArtifacts.length - selected.length,
  };
  if (await isThreadSessionClosed(input.env, input.channel, input.threadTs, input.sessionId))
    return result;
  const staged: StagedFile[] = [];
  let attemptedBytes = 0;

  for (const artifact of selected) {
    if (
      artifact.sizeBytes !== undefined &&
      (artifact.sizeBytes > SLACK_MEDIA_MAX_FILE_BYTES ||
        attemptedBytes + artifact.sizeBytes > SLACK_MEDIA_MAX_TOTAL_BYTES)
    ) {
      result.omitted += 1;
      continue;
    }

    let stage: StageResult;
    try {
      stage = await stageArtifact(input, artifact, attemptedBytes);
    } catch (error) {
      log.warn("slack.media.stage", {
        trace_id: input.traceId,
        session_id: input.sessionId,
        message_id: input.messageId,
        artifact_id: artifact.id,
        outcome: "error",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      stage = { kind: "failed" };
    }
    if (stage.kind === "omitted") {
      result.omitted += 1;
      continue;
    }
    if (stage.sizeBytes !== undefined) attemptedBytes += stage.sizeBytes;
    if (stage.kind === "failed") {
      // Failed staging may conceal revoked access to staged files or already-extracted text.
      const access = await checkPublicationAccess(
        input.env,
        input.sessionId,
        input.channel,
        input.traceId
      );
      if (access !== "allowed")
        throw new ProtectedReadError(
          `Control plane publication access ${access}`,
          access === "denied" ? 403 : undefined
        );
      result.failed += 1;
      continue;
    }
    staged.push(stage.file);
  }

  if (
    staged.length === 0 ||
    (await isThreadSessionClosed(input.env, input.channel, input.threadTs, input.sessionId))
  )
    return result;

  input.onShareAttempt();
  const complete = await completeExternalUpload(input.env.SLACK_BOT_TOKEN, {
    files: staged,
    channelId: input.channel,
    threadTs: input.threadTs,
    signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
  });
  if (!complete.ok) {
    log.warn("slack.media.complete_upload", {
      trace_id: input.traceId,
      session_id: input.sessionId,
      message_id: input.messageId,
      outcome: "error",
      slack_error: complete.error,
      slack_file_ids: staged.map((file) => file.id),
    });
    result.failed += staged.length;
    return result;
  }

  result.uploaded = staged.length;
  log.info("slack.media.delivery", {
    trace_id: input.traceId,
    session_id: input.sessionId,
    message_id: input.messageId,
    outcome: "success",
    uploaded: result.uploaded,
    failed: result.failed,
    omitted: result.omitted,
    attempted_bytes: attemptedBytes,
  });
  return result;
}

async function stageArtifact(
  input: DeliverMediaArtifactsInput,
  artifact: MediaArtifactInfo,
  attemptedBytes: number
): Promise<StageResult> {
  const base = {
    trace_id: input.traceId,
    session_id: input.sessionId,
    message_id: input.messageId,
    artifact_id: artifact.id,
    artifact_type: artifact.type,
  };
  const mediaUrl = new URL(
    `https://internal/sessions/${encodeURIComponent(input.sessionId)}/media/${encodeURIComponent(artifact.id)}`
  );
  mediaUrl.searchParams.set("channel", `slack:${input.channel}`);
  mediaUrl.searchParams.set("purpose", "slack-post");
  let response: Response;
  try {
    response = await signedControlPlaneFetch(
      input.env,
      { method: "GET", url: mediaUrl.toString(), traceId: input.traceId },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
  } catch (error) {
    throw new ProtectedReadError("Control plane media read unavailable", undefined, {
      cause: error,
    });
  }
  if (!response.ok || !response.body) {
    await cancelBody(response.body);
    log.warn("slack.media.fetch", { ...base, outcome: "error", http_status: response.status });
    throw new ProtectedReadError(
      `Control plane media read failed: ${response.status}`,
      response.status
    );
  }

  const mimeType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim() ?? "";
  const extension = EXTENSIONS[mimeType];
  const sizeBytes = Number(response.headers.get("Content-Length"));
  if (!extension || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    await cancelBody(response.body);
    log.warn("slack.media.fetch", { ...base, outcome: "error", error: "invalid_media_headers" });
    throw new ProtectedReadError("Invalid media response headers");
  }
  if (
    sizeBytes > SLACK_MEDIA_MAX_FILE_BYTES ||
    attemptedBytes + sizeBytes > SLACK_MEDIA_MAX_TOTAL_BYTES
  ) {
    await cancelBody(response.body);
    log.info("slack.media.delivery", { ...base, outcome: "omitted", size_bytes: sizeBytes });
    return { kind: "omitted" };
  }

  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readBodyCapped(response.body, sizeBytes);
  } catch (error) {
    throw new ProtectedReadError("Control plane media body read unavailable", undefined, {
      cause: error,
    });
  }
  if (!bytes || bytes.byteLength !== sizeBytes)
    throw new ProtectedReadError("Invalid media response length");

  const title = artifact.caption?.trim() || `${artifact.type} ${artifact.id}`;
  const ticket = await getExternalUploadUrl(input.env.SLACK_BOT_TOKEN, {
    filename: `artifact-${artifact.id}.${extension}`,
    length: sizeBytes,
    altText: title.slice(0, ALT_TEXT_LIMIT),
    signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
  });
  if (!ticket.ok) {
    log.warn("slack.media.get_upload_url", {
      ...base,
      outcome: "error",
      slack_error: ticket.error,
    });
    return { kind: "failed", sizeBytes };
  }

  const upload = await uploadToExternalUrl(
    ticket.upload_url,
    bytes,
    mimeType,
    AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS)
  );
  if (!upload.ok) {
    log.warn("slack.media.upload_bytes", { ...base, outcome: "error", slack_error: upload.error });
    return { kind: "failed", sizeBytes };
  }

  return { kind: "staged", sizeBytes, file: { id: ticket.file_id, title } };
}

async function cancelBody(body: ReadableStream | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Cancellation must not change the read failure classification.
  }
}
