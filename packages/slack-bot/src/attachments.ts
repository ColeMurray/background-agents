/**
 * Forward image files attached to Slack messages into a session as prompt
 * attachments.
 *
 * Slack file bytes live behind `url_private`, which requires the bot token to
 * download (and the `files:read` scope). Each supported image is downloaded and
 * uploaded to the control plane's session-attachments store; the prompt then
 * carries only `{ attachmentId, name }` references, matching how the web
 * composer attaches images.
 */

import {
  buildInternalAuthHeaders,
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  postMessage,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  type SessionAttachmentReference,
  type SlackMessageFile,
} from "@open-inspect/shared";
import { createLogger } from "./logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "./request-options";
import type { Env } from "./types";

const log = createLogger("attachments");

/** Mirrors the control plane's SESSION_ATTACHMENT_IMAGE_MAX_BYTES cap. */
export const SLACK_ATTACHMENT_MAX_FILE_BYTES = 10 * 1024 * 1024;

const ATTACHMENT_NAME_MAX_LENGTH = 255;

const SUPPORTED_MIME_TYPES = new Set<string>(SESSION_ATTACHMENT_IMAGE_MIME_TYPES);

export interface SlackAttachmentUploadResult {
  references: SessionAttachmentReference[];
  /**
   * How many image files the user attached that did NOT make it through
   * (download failure, oversized, upload rejection, or over the per-message
   * cap). Lets callers surface a visible "couldn't read your image" note
   * instead of silently dropping it — the most common cause is a missing
   * `files:read` scope.
   */
  droppedCount: number;
}

/** The image files on a message, i.e. the ones eligible for forwarding. */
export function extractImageFiles(files: SlackMessageFile[] | undefined): SlackMessageFile[] {
  if (!files?.length) return [];
  return files.filter((file) => file.mimetype && SUPPORTED_MIME_TYPES.has(file.mimetype));
}

function attachmentName(file: SlackMessageFile): string {
  const name = file.name || file.title || `${file.id ?? "image"}.png`;
  return name.slice(0, ATTACHMENT_NAME_MAX_LENGTH);
}

async function downloadSlackFile(
  token: string,
  file: SlackMessageFile,
  traceId?: string
): Promise<Uint8Array | null> {
  const downloadUrl = file.url_private_download || file.url_private;
  if (!downloadUrl) return null;
  try {
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("slack.attachment.download_failed", {
        trace_id: traceId,
        file_id: file.id,
        http_status: res.status,
      });
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > SLACK_ATTACHMENT_MAX_FILE_BYTES) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: file.id,
        size_bytes: bytes.byteLength,
      });
      return null;
    }
    return bytes;
  } catch (e) {
    log.warn("slack.attachment.download_error", {
      trace_id: traceId,
      file_id: file.id,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

async function uploadToSession(
  env: Env,
  sessionId: string,
  file: SlackMessageFile,
  bytes: Uint8Array,
  traceId?: string
): Promise<SessionAttachmentReference | null> {
  const name = attachmentName(file);
  try {
    const formData = new FormData();
    formData.append(
      "file",
      new File([bytes], name, { type: file.mimetype ?? "application/octet-stream" })
    );
    const response = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${sessionId}/attachments`,
      {
        method: "POST",
        // No Content-Type here: FormData sets the multipart boundary itself.
        headers: await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId),
        body: formData,
        signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
      }
    );
    if (!response.ok) {
      log.warn("slack.attachment.upload_failed", {
        trace_id: traceId,
        session_id: sessionId,
        file_id: file.id,
        http_status: response.status,
      });
      return null;
    }
    const body = (await response.json()) as { attachmentId?: unknown };
    if (typeof body.attachmentId !== "string" || !body.attachmentId) {
      log.warn("slack.attachment.upload_failed", {
        trace_id: traceId,
        session_id: sessionId,
        file_id: file.id,
        error: new Error("Invalid attachment upload response"),
      });
      return null;
    }
    return { attachmentId: body.attachmentId, name };
  } catch (e) {
    log.warn("slack.attachment.upload_error", {
      trace_id: traceId,
      session_id: sessionId,
      file_id: file.id,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

/**
 * Download the image files in `files` and store them as attachments on
 * `sessionId`, returning prompt references. Non-images, oversized files, and
 * failed downloads/uploads are skipped (logged) so a bad file never blocks the
 * message; `droppedCount` reports how many images were lost so the caller can
 * tell the user.
 */
export async function uploadSlackImageAttachments(
  env: Env,
  sessionId: string,
  files: SlackMessageFile[] | undefined,
  traceId?: string
): Promise<SlackAttachmentUploadResult> {
  const images = extractImageFiles(files);
  if (images.length === 0) return { references: [], droppedCount: 0 };

  const references: SessionAttachmentReference[] = [];
  for (const file of images.slice(0, MAX_SESSION_ATTACHMENTS_PER_MESSAGE)) {
    if (typeof file.size === "number" && file.size > SLACK_ATTACHMENT_MAX_FILE_BYTES) {
      log.warn("slack.attachment.too_large", {
        trace_id: traceId,
        file_id: file.id,
        size_bytes: file.size,
      });
      continue;
    }
    const bytes = await downloadSlackFile(env.SLACK_BOT_TOKEN, file, traceId);
    if (!bytes) continue;
    const reference = await uploadToSession(env, sessionId, file, bytes, traceId);
    if (reference) references.push(reference);
  }

  // Everything the user attached as an image that didn't survive (failed
  // downloads/uploads, oversized files, and anything beyond the per-message cap).
  return { references, droppedCount: images.length - references.length };
}

/**
 * Tell the user how many of their attached images could not be forwarded. The
 * most common root cause is the Slack app missing the `files:read` scope, so
 * the note names it. Best effort — never blocks the message.
 */
export async function notifyDroppedAttachments(
  env: Env,
  channel: string,
  threadTs: string,
  droppedCount: number,
  traceId?: string
): Promise<void> {
  if (droppedCount <= 0) return;
  const noun = droppedCount === 1 ? "image" : "images";
  const pronoun = droppedCount === 1 ? "it wasn't" : "they weren't";
  const result = await postMessage(
    env.SLACK_BOT_TOKEN,
    channel,
    `:warning: I couldn't read ${droppedCount} attached ${noun}, so ${pronoun} sent to the agent. ` +
      "If this keeps happening, the bot may be missing the `files:read` Slack scope — an admin can add it and reinstall the app.",
    { thread_ts: threadTs }
  );
  if (!result.ok) {
    log.warn("slack.attachment.notify_failed", {
      trace_id: traceId,
      channel,
      slack_error: result.error,
    });
  }
}
