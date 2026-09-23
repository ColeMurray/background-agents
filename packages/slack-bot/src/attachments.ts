/**
 * Forward image files attached to Slack messages into a session as prompt
 * attachments.
 *
 * Slack file bytes live behind `url_private`, which requires the bot token to
 * download (and the `files:read` scope). Raw Slack file payloads are
 * normalized into {@link SlackImageAttachment} once at event ingress; every
 * later stage (download, upload, pending-request state) works only with that
 * model. Each supported image is downloaded and uploaded to the control
 * plane's session-attachments store; the prompt then carries only
 * `{ attachmentId, name }` references, matching how the web composer attaches
 * images.
 */

import { postMessage, type SlackMessageFile } from "@open-inspect/shared/slack";
import {
  MAX_SESSION_ATTACHMENTS_PER_MESSAGE,
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  SESSION_ATTACHMENT_IMAGE_MIME_TYPES,
  sessionAttachmentUploadResponseSchema,
  type SessionAttachmentReference,
} from "@open-inspect/shared/types/session-attachments";
import { readBodyCapped } from "@open-inspect/shared/http-body";
import { signedControlPlaneFetch } from "./internal-auth";
import { createLogger } from "./logger";
import { OUTBOUND_REQUEST_TIMEOUT_MS } from "./request-options";
import type { Env } from "./types";

const log = createLogger("attachments");

const ATTACHMENT_NAME_MAX_LENGTH = 255;
const MAX_ATTACHMENT_DOWNLOAD_CANDIDATES = MAX_SESSION_ATTACHMENTS_PER_MESSAGE * 2;

const SUPPORTED_MIME_TYPES = new Set<string>(SESSION_ATTACHMENT_IMAGE_MIME_TYPES);

/** Prompt body used when a message carries images but no user text. */
export const IMAGE_ONLY_PROMPT_TEXT = "See the attached image(s).";

/**
 * A Slack-attached image validated at event ingress: supported mime type and a
 * Slack-hosted download URL the bot token may be sent to. This is the only
 * shape that flows past the event handlers — raw `SlackMessageFile` payloads
 * never reach downloads, session launch, or KV state.
 */
export interface SlackImageAttachment {
  /** Slack file id, used for log correlation only. */
  id?: string;
  /** Display name, bounded to the attachment store's length limit. */
  name: string;
  mimetype: string;
  /** Declared size in bytes, when Slack provided one. */
  size?: number;
  /** https URL on slack.com / *.slack.com serving the file bytes. */
  downloadUrl: string;
}

/** Why an attached image did not make it to the session. */
export type SlackAttachmentDropReason =
  | "download_failed"
  | "too_large"
  | "over_cap"
  | "upload_rejected";

/** Downloaded image bytes plus a record of every image that was lost. */
export interface PreparedImageAttachments {
  files: Array<{
    attachment: SlackImageAttachment;
    bytes: Uint8Array;
    /** False for prior-thread context, whose failures must not be blamed on the current user. */
    reportDrop?: false;
  }>;
  /**
   * One entry per image the user attached that did NOT make it through, so
   * callers can surface a visible "couldn't read your image" note — tailored
   * to the reason — instead of silently dropping it.
   */
  dropped: SlackAttachmentDropReason[];
}

export interface SlackAttachmentUploadResult {
  references: SessionAttachmentReference[];
  /** Drop reasons carried over from download plus any upload failures. */
  dropped: SlackAttachmentDropReason[];
  /**
   * True when every upload was rejected with 404 — the session no longer
   * exists, so the failures are stale-session noise rather than real drops.
   */
  sessionMissing: boolean;
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

function isForwardableSlackImage(file: SlackMessageFile): boolean {
  const downloadUrl = file.url_private_download || file.url_private;
  return Boolean(
    file.mimetype &&
    SUPPORTED_MIME_TYPES.has(file.mimetype) &&
    downloadUrl &&
    file.mode !== "external" &&
    isTrustedSlackFileUrl(downloadUrl)
  );
}

/**
 * Render bounded, URL-free metadata for files carried by an earlier thread
 * message. Automation context remains byte-free; interactive context can also
 * forward supported images through the normal attachment pipeline.
 */
export function slackFileAnnotations(
  files: SlackMessageFile[] | undefined,
  mode: "interactive" | "automation"
): string[] {
  if (!files?.length) return [];
  const annotations = files.slice(0, MAX_SESSION_ATTACHMENTS_PER_MESSAGE).map((file) => {
    const supported = isForwardableSlackImage(file);
    const status = supported
      ? mode === "interactive"
        ? "supported image; eligible for secure forwarding"
        : "supported image; not forwarded by Slack Message automations"
      : "unsupported or unavailable file; not forwarded";
    return `Slack file: ${JSON.stringify({
      name: (file.name || file.title || file.id || "unnamed file").slice(
        0,
        ATTACHMENT_NAME_MAX_LENGTH
      ),
      mimetype: file.mimetype || "unknown",
      status,
    })}`;
  });
  if (files.length > MAX_SESSION_ATTACHMENTS_PER_MESSAGE) {
    annotations.push(
      `Slack files: ${files.length - MAX_SESSION_ATTACHMENTS_PER_MESSAGE} additional file(s) omitted from context`
    );
  }
  return annotations;
}

/**
 * Normalize raw Slack file payloads into validated image attachments. Called
 * once where files enter the bot (event handlers, pending-request delivery);
 * everything downstream accepts only the result. Non-images are ignored;
 * images that can never be fetched safely — remote (`mode: "external"`) files
 * and non-Slack-hosted URLs — are skipped with a log so the drop is visible.
 */
export function toImageAttachments(
  files: SlackMessageFile[] | undefined,
  traceId?: string
): SlackImageAttachment[] {
  if (!files?.length) return [];
  const attachments: SlackImageAttachment[] = [];
  for (const file of files) {
    if (!file.mimetype || !SUPPORTED_MIME_TYPES.has(file.mimetype)) continue;
    const downloadUrl = file.url_private_download || file.url_private;
    // Remote files are third-party-hosted and not fetchable with the bot
    // token; their URLs must never receive it either.
    if (!downloadUrl || file.mode === "external" || !isTrustedSlackFileUrl(downloadUrl)) {
      log.warn("slack.attachment.untrusted_url", {
        trace_id: traceId,
        file_id: file.id,
        file_mode: file.mode,
      });
      continue;
    }
    const name = file.name || file.title || `${file.id ?? "image"}.png`;
    attachments.push({
      id: file.id,
      name: name.slice(0, ATTACHMENT_NAME_MAX_LENGTH),
      mimetype: file.mimetype,
      size: file.size,
      downloadUrl,
    });
  }
  return attachments;
}

function attachmentIdentity(attachment: SlackImageAttachment): string {
  return attachment.id ? `id:${attachment.id}` : `url:${attachment.downloadUrl}`;
}

/**
 * Fetch an image's bytes with the bot token, enforcing the trusted host policy
 * (re-checked here as defense in depth) and the image byte cap. Returns a drop
 * reason instead of bytes when the file cannot be safely fetched.
 */
async function downloadSlackFile(
  token: string,
  attachment: SlackImageAttachment,
  traceId?: string
): Promise<{ bytes: Uint8Array } | { dropReason: SlackAttachmentDropReason }> {
  if (!isTrustedSlackFileUrl(attachment.downloadUrl)) {
    log.warn("slack.attachment.untrusted_url", { trace_id: traceId, file_id: attachment.id });
    return { dropReason: "download_failed" };
  }
  try {
    const res = await fetch(attachment.downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
      // A redirect off *.slack.com must not carry the token; fail instead.
      redirect: "manual",
      signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn("slack.attachment.download_failed", {
        trace_id: traceId,
        file_id: attachment.id,
        http_status: res.status,
      });
      return { dropReason: "download_failed" };
    }
    const contentLength = Number(res.headers.get("Content-Length"));
    if (Number.isFinite(contentLength) && contentLength > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: attachment.id,
        size_bytes: contentLength,
      });
      return { dropReason: "too_large" };
    }
    const bytes = await readBodyCapped(res.body, SESSION_ATTACHMENT_IMAGE_MAX_BYTES);
    if (bytes === null || bytes.byteLength === 0) {
      log.warn("slack.attachment.size_rejected", {
        trace_id: traceId,
        file_id: attachment.id,
        size_bytes: bytes === null ? -1 : 0,
      });
      return { dropReason: bytes === null ? "too_large" : "download_failed" };
    }
    return { bytes };
  } catch (e) {
    log.warn("slack.attachment.download_error", {
      trace_id: traceId,
      file_id: attachment.id,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return { dropReason: "download_failed" };
  }
}

/**
 * Download image bytes in batches no larger than the remaining prompt slots.
 * Failed candidates leave room for later candidates, while six successful
 * downloads stop further work. Candidate attempts are also bounded defensively.
 * Runs before a session exists so callers can avoid creating one when an
 * image-only request yields nothing.
 */
export async function prepareImageAttachments(
  env: Env,
  attachments: SlackImageAttachment[],
  traceId?: string
): Promise<PreparedImageAttachments> {
  return prepareImageCandidates(
    env,
    attachments.map((attachment) => ({ attachment, reportDrop: true })),
    traceId
  );
}

interface ImageCandidate {
  attachment: SlackImageAttachment;
  reportDrop: boolean;
}

async function prepareImageCandidates(
  env: Env,
  candidates: ImageCandidate[],
  traceId?: string
): Promise<PreparedImageAttachments> {
  if (candidates.length === 0) return { files: [], dropped: [] };

  const files: PreparedImageAttachments["files"] = [];
  const dropped: SlackAttachmentDropReason[] = [];
  const boundedCandidates = candidates.slice(0, MAX_ATTACHMENT_DOWNLOAD_CANDIDATES);
  for (const candidate of candidates.slice(MAX_ATTACHMENT_DOWNLOAD_CANDIDATES)) {
    if (candidate.reportDrop) dropped.push("over_cap");
  }
  type DownloadOutcome =
    | { candidate: ImageCandidate; bytes: Uint8Array }
    | { candidate: ImageCandidate; dropReason: SlackAttachmentDropReason };
  let candidateIndex = 0;

  while (
    candidateIndex < boundedCandidates.length &&
    files.length < MAX_SESSION_ATTACHMENTS_PER_MESSAGE
  ) {
    const remaining = MAX_SESSION_ATTACHMENTS_PER_MESSAGE - files.length;
    const batch = boundedCandidates.slice(candidateIndex, candidateIndex + remaining);
    candidateIndex += batch.length;
    const outcomes = await Promise.all(
      batch.map(async (candidate): Promise<DownloadOutcome> => {
        const { attachment } = candidate;
        if (
          typeof attachment.size === "number" &&
          attachment.size > SESSION_ATTACHMENT_IMAGE_MAX_BYTES
        ) {
          log.warn("slack.attachment.too_large", {
            trace_id: traceId,
            file_id: attachment.id,
            size_bytes: attachment.size,
          });
          return { candidate, dropReason: "too_large" as const };
        }
        const download = await downloadSlackFile(env.SLACK_BOT_TOKEN, attachment, traceId);
        return "dropReason" in download
          ? { candidate, dropReason: download.dropReason }
          : { candidate, bytes: download.bytes };
      })
    );

    for (const outcome of outcomes) {
      if ("bytes" in outcome) {
        const prepared = { attachment: outcome.candidate.attachment, bytes: outcome.bytes };
        files.push(
          outcome.candidate.reportDrop ? prepared : { ...prepared, reportDrop: false as const }
        );
      } else if (outcome.candidate.reportDrop) {
        dropped.push(outcome.dropReason);
      }
    }
  }

  for (const candidate of boundedCandidates.slice(candidateIndex)) {
    if (candidate.reportDrop) dropped.push("over_cap");
  }
  return { files, dropped };
}

/**
 * Prepare current-message images first, then fill the remaining prompt slots
 * with deduplicated images from earlier selected thread messages. Context-only
 * overflow is silently omitted because it is not a dropped current-user input.
 */
export async function preparePromptImageAttachments(
  env: Env,
  current: SlackImageAttachment[],
  context: SlackImageAttachment[],
  traceId?: string
): Promise<PreparedImageAttachments> {
  const seen = new Set(current.map(attachmentIdentity));
  const contextual = context.filter((attachment) => {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
  return prepareImageCandidates(
    env,
    [
      ...current.map((attachment) => ({ attachment, reportDrop: true })),
      ...contextual.map((attachment) => ({ attachment, reportDrop: false })),
    ],
    traceId
  );
}

/**
 * Store one image in the session's attachment store and return the prompt
 * reference, or the failure kind when the control plane rejects it.
 */
async function uploadToSession(
  env: Env,
  sessionId: string,
  file: PreparedImageAttachments["files"][number],
  authorId: string,
  traceId?: string
): Promise<
  { reference: SessionAttachmentReference } | { sessionMissing: boolean; reportDrop: boolean }
> {
  const { attachment, bytes } = file;
  try {
    const formData = new FormData();
    formData.append("file", new File([bytes], attachment.name, { type: attachment.mimetype }));
    // sig1 hashes the exact body bytes, so the multipart form (whose boundary
    // is generated at serialization time) is serialized ONCE here; the signed
    // bytes, the Content-Type boundary, and the bytes sent are all from this
    // single serialization.
    const serialized = new Request("https://internal/", { method: "POST", body: formData });
    const multipartBytes = new Uint8Array(await serialized.arrayBuffer());
    const contentType = serialized.headers.get("Content-Type");
    if (!contentType) {
      throw new Error("FormData serialization produced no Content-Type");
    }
    const response = await signedControlPlaneFetch(
      env,
      {
        method: "POST",
        url: `https://internal/sessions/${sessionId}/attachments`,
        body: { bytes: multipartBytes, contentType },
        actor: authorId.startsWith("slack:") ? authorId : undefined,
        traceId,
      },
      { signal: AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS) }
    );
    if (!response.ok) {
      log.warn("slack.attachment.upload_failed", {
        trace_id: traceId,
        session_id: sessionId,
        file_id: attachment.id,
        http_status: response.status,
      });
      return { sessionMissing: response.status === 404, reportDrop: file.reportDrop !== false };
    }
    const parsed = sessionAttachmentUploadResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      log.warn("slack.attachment.upload_failed", {
        trace_id: traceId,
        session_id: sessionId,
        file_id: attachment.id,
        error: new Error("Invalid attachment upload response"),
      });
      return { sessionMissing: false, reportDrop: file.reportDrop !== false };
    }
    return { reference: { attachmentId: parsed.data.attachmentId, name: attachment.name } };
  } catch (e) {
    log.warn("slack.attachment.upload_error", {
      trace_id: traceId,
      session_id: sessionId,
      file_id: attachment.id,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return { sessionMissing: false, reportDrop: file.reportDrop !== false };
  }
}

/**
 * Store the prepared images as attachments on `sessionId` concurrently,
 * returning prompt references in the original order. Failed uploads are
 * recorded (never thrown) so a bad file never blocks the message; the result
 * carries the prepare-stage drops forward so one notification covers both.
 */
export async function uploadPreparedAttachments(
  env: Env,
  sessionId: string,
  prepared: PreparedImageAttachments,
  authorId: string,
  traceId?: string
): Promise<SlackAttachmentUploadResult> {
  const outcomes = await Promise.all(
    prepared.files.map((file) => uploadToSession(env, sessionId, file, authorId, traceId))
  );
  const references: SessionAttachmentReference[] = [];
  const dropped: SlackAttachmentDropReason[] = [...prepared.dropped];
  const failures: Array<{ sessionMissing: boolean }> = [];
  for (const outcome of outcomes) {
    if ("reference" in outcome) references.push(outcome.reference);
    else {
      if (outcome.reportDrop) dropped.push("upload_rejected");
      failures.push(outcome);
    }
  }
  return {
    references,
    dropped,
    sessionMissing:
      references.length === 0 && failures.length > 0 && failures.every((f) => f.sessionMissing),
  };
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
  result: { references: SessionAttachmentReference[]; dropped: SlackAttachmentDropReason[] },
  options: {
    traceId?: string;
    /** True when no run started at all because every image was lost. */
    nothingSent?: boolean;
  } = {}
): Promise<void> {
  const { traceId, nothingSent } = options;
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
  const consequence = nothingSent
    ? "so I didn't start on this request"
    : `so ${pronoun} sent to the agent`;
  const message = [
    `:warning: I couldn't read ${droppedCount} attached ${noun}, ${consequence}.`,
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
