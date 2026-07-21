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
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  type SessionAttachmentReference,
  type SlackMessageFile,
} from "@open-inspect/shared";
import { createLogger } from "./logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "./request-options";
import type { Env } from "./types";

const log = createLogger("attachments");

const ATTACHMENT_NAME_MAX_LENGTH = 255;

const SUPPORTED_MIME_TYPES = new Set<string>(SESSION_ATTACHMENT_IMAGE_MIME_TYPES);

/** Why an attached image did not make it to the session. */
export type SlackAttachmentDropReason =
  | "download_failed"
  | "too_large"
  | "over_cap"
  | "upload_rejected";

export interface SlackAttachmentUploadResult {
  references: SessionAttachmentReference[];
  /**
   * One entry per image file the user attached that did NOT make it through.
   * Lets callers surface a visible "couldn't read your image" note — tailored
   * to the reason — instead of silently dropping it.
   */
  dropped: SlackAttachmentDropReason[];
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

/**
 * Only Slack-hosted file URLs may see the bot token. File objects arrive on
 * webhook payloads, and Slack "remote" files (files.remote.add) carry an
 * arbitrary registrant-supplied `url_private` — following one would hand the
 * `Authorization: Bearer` header to that host.
 */
function isTrustedSlackFileUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname === "slack.com" || url.hostname.endsWith(".slack.com");
}

/** Read the body with a hard byte cap, cancelling as soon as it is exceeded. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function downloadSlackFile(
  token: string,
  file: SlackMessageFile,
  traceId?: string
): Promise<{ bytes: Uint8Array } | { dropReason: SlackAttachmentDropReason }> {
  const downloadUrl = file.url_private_download || file.url_private;
  // Remote files (mode "external") are third-party-hosted and not fetchable
  // with the bot token; their URLs must never receive it either.
  if (!downloadUrl || file.mode === "external" || !isTrustedSlackFileUrl(downloadUrl)) {
    log.warn("slack.attachment.untrusted_url", {
      trace_id: traceId,
      file_id: file.id,
      file_mode: file.mode,
    });
    return { dropReason: "download_failed" };
  }
  try {
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      // A redirect off *.slack.com must not carry the token; fail instead.
      redirect: "manual",
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("slack.attachment.download_failed", {
        trace_id: traceId,
        file_id: file.id,
        http_status: res.status,
      });
      return { dropReason: "download_failed" };
    }
    const contentLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: file.id,
        size_bytes: contentLength,
      });
      return { dropReason: "too_large" };
    }
    const bytes = await readBodyCapped(res, SESSION_ATTACHMENT_IMAGE_MAX_BYTES);
    if (bytes === null || bytes.byteLength === 0) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: file.id,
        size_bytes: bytes === null ? -1 : 0,
      });
      return { dropReason: bytes === null ? "too_large" : "download_failed" };
    }
    return { bytes };
  } catch (e) {
    log.warn("slack.attachment.download_error", {
      trace_id: traceId,
      file_id: file.id,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return { dropReason: "download_failed" };
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
 * message; `dropped` records each lost image with the reason so the caller can
 * tell the user.
 */
export async function uploadSlackImageAttachments(
  env: Env,
  sessionId: string,
  files: SlackMessageFile[] | undefined,
  traceId?: string
): Promise<SlackAttachmentUploadResult> {
  const images = extractImageFiles(files);
  if (images.length === 0) return { references: [], dropped: [] };

  const references: SessionAttachmentReference[] = [];
  const dropped: SlackAttachmentDropReason[] = [];
  for (const file of images.slice(0, MAX_SESSION_ATTACHMENTS_PER_MESSAGE)) {
    if (typeof file.size === "number" && file.size > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
      log.warn("slack.attachment.too_large", {
        trace_id: traceId,
        file_id: file.id,
        size_bytes: file.size,
      });
      dropped.push("too_large");
      continue;
    }
    const download = await downloadSlackFile(env.SLACK_BOT_TOKEN, file, traceId);
    if ("dropReason" in download) {
      dropped.push(download.dropReason);
      continue;
    }
    const reference = await uploadToSession(env, sessionId, file, download.bytes, traceId);
    if (reference) references.push(reference);
    else dropped.push("upload_rejected");
  }
  for (const _ of images.slice(MAX_SESSION_ATTACHMENTS_PER_MESSAGE)) {
    dropped.push("over_cap");
  }

  return { references, dropped };
}

/**
 * Tell the user how many of their attached images could not be forwarded, with
 * guidance matched to why. Call this only once the prompt outcome is known —
 * uploads against a stale session fail spuriously and are retried against the
 * replacement session. Best effort — never blocks the message.
 */
export async function notifyDroppedAttachments(
  env: Env,
  channel: string,
  threadTs: string,
  result: SlackAttachmentUploadResult,
  traceId?: string
): Promise<void> {
  const droppedCount = result.dropped.length;
  if (droppedCount <= 0) return;
  const noun = droppedCount === 1 ? "image" : "images";
  const pronoun = droppedCount === 1 ? "it wasn't" : "they weren't";
  const reasons = new Set(result.dropped);
  const hints: string[] = [];
  if (reasons.has("download_failed")) {
    hints.push(
      "If this keeps happening, the bot may be missing the `files:read` Slack scope — an admin can add it and reinstall the app."
    );
  }
  if (reasons.has("too_large")) {
    const maxMb = Math.floor(SESSION_ATTACHMENT_IMAGE_MAX_BYTES / (1024 * 1024));
    hints.push(`Images must be ${maxMb} MB or smaller.`);
  }
  if (reasons.has("over_cap")) {
    hints.push(`I can forward at most ${MAX_SESSION_ATTACHMENTS_PER_MESSAGE} images per message.`);
  }
  const message = [
    `:warning: I couldn't read ${droppedCount} attached ${noun}, so ${pronoun} sent to the agent.`,
    ...hints,
  ].join(" ");
  const postResult = await postMessage(env.SLACK_BOT_TOKEN, channel, message, {
    thread_ts: threadTs,
  });
  if (!postResult.ok) {
    log.warn("slack.attachment.notify_failed", {
      trace_id: traceId,
      channel,
      slack_error: postResult.error,
    });
  }
}
