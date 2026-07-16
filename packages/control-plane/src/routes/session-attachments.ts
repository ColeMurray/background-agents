/**
 * Session image attachments added through the chat composer.
 *
 * POST stores the file in the media bucket keyed by an unguessable attachment id;
 * the prompt then references it as `{ attachmentId, name }` so the message row and
 * user_message event stay small (Durable Object SQLite rows cap at 2 MB —
 * base64 payloads must never ride through the message queue).
 *
 * GET streams the file back. It is HMAC-authenticated for the web app's proxy
 * route and sandbox-token-authenticated so the bridge can hydrate attachments
 * before prompting OpenCode (see SANDBOX_AUTH_ROUTES in router.ts).
 *
 * Every stored object is registered as an attachment record in the session DO,
 * which enforces per-session quotas and prunes records never referenced by a
 * prompt within the TTL. The DO returns those stale object keys and this route
 * deletes them from storage.
 */

import { sessionAttachmentIdSchema } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  buildSessionAttachmentObjectKey,
  detectSessionAttachmentFileType,
  isMultipartFile,
  isSupportedSessionAttachmentMimeType,
  SESSION_ATTACHMENT_IMAGE_MAX_BYTES,
  sessionAttachmentRequestExceedsLimit,
} from "../media";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { streamStoredMedia } from "./stream-stored-media";
import { SessionAttachmentStorageService } from "../session/services/session-attachment-storage.service";

const logger = createLogger("router:session-attachments");

async function handleAttachmentPost(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  if (sessionAttachmentRequestExceedsLimit(request)) {
    return error("Attachment request is too large", 413);
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return error("Invalid multipart form data", 400);
  }

  const fileEntry = formData.get("file");
  if (!isMultipartFile(fileEntry)) {
    return error("file is required", 400);
  }

  if (fileEntry.size <= 0) {
    return error("Uploaded file is empty", 400);
  }

  if (fileEntry.type && !isSupportedSessionAttachmentMimeType(fileEntry.type)) {
    return error("Unsupported attachment MIME type", 400);
  }

  if (fileEntry.size > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
    return error(`Images must be ${SESSION_ATTACHMENT_IMAGE_MAX_BYTES} bytes or smaller`, 400);
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const detected = detectSessionAttachmentFileType(bytes);
  if (!detected) {
    return error("Uploaded file is not a supported image format", 400);
  }

  if (bytes.byteLength > SESSION_ATTACHMENT_IMAGE_MAX_BYTES) {
    return error(`Images must be ${SESSION_ATTACHMENT_IMAGE_MAX_BYTES} bytes or smaller`, 400);
  }

  if (fileEntry.type && fileEntry.type !== detected.mimeType) {
    return error("Uploaded file MIME type does not match file contents", 400);
  }

  const attachmentId = generateId();
  const objectKey = buildSessionAttachmentObjectKey(sessionId, attachmentId);
  const storage = createMediaObjectStorage(env);
  const attachmentStorage = new SessionAttachmentStorageService(
    ctx.sessionRuntime,
    storage,
    sessionId,
    logger,
    {
      requestId: ctx.request_id,
      traceId: ctx.trace_id,
    }
  );
  const stored = await attachmentStorage.store(bytes, {
    attachmentId,
    mimeType: detected.mimeType,
    sizeBytes: bytes.byteLength,
    objectKey,
  });
  if (!stored.ok) return error(stored.error, stored.status);

  logger.info("attachments.stored", {
    session_id: sessionId,
    attachment_id: attachmentId,
    mime_type: detected.mimeType,
    size_bytes: bytes.byteLength,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ attachmentId, mimeType: detected.mimeType }, 201);
}

async function handleAttachmentGet(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const attachmentId = match.groups?.attachmentId;
  if (!sessionId || !attachmentId) {
    return error("Session ID and attachment ID are required", 400);
  }
  if (!sessionAttachmentIdSchema.safeParse(attachmentId).success) {
    return error("Invalid attachment ID", 400);
  }

  const storage = createMediaObjectStorage(env);
  const objectKey = buildSessionAttachmentObjectKey(sessionId, attachmentId);

  return streamStoredMedia({
    request,
    storage,
    objectKey,
    isAllowedContentType: isSupportedSessionAttachmentMimeType,
    notFound: () => error("Attachment not found", 404),
    invalidMetadata: (contentType) => {
      logger.error("attachments.invalid_metadata", {
        session_id: sessionId,
        attachment_id: attachmentId,
        content_type: contentType,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Attachment is invalid", 500);
    },
  });
}

export const sessionAttachmentRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/attachments"),
    handler: handleAttachmentPost,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/attachments/:attachmentId"),
    handler: handleAttachmentGet,
  }),
];
