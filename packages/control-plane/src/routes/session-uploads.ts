/**
 * User-attached prompt images (chat composer attachments).
 *
 * POST stores the file in the media bucket keyed by an unguessable upload id;
 * the prompt then references it as `{ uploadId, name }` so the message row and
 * user_message event stay small (Durable Object SQLite rows cap at 2 MB —
 * base64 payloads must never ride through the message queue).
 *
 * GET streams the file back. It is HMAC-authenticated for the web app's proxy
 * route and sandbox-token-authenticated so the bridge can hydrate attachments
 * before prompting OpenCode (see SANDBOX_AUTH_ROUTES in router.ts).
 *
 * Every stored object is registered as an upload record in the session DO,
 * which enforces per-session quotas and prunes records never referenced by a
 * prompt within the TTL. The DO returns those stale object keys and this route
 * deletes them from storage.
 */

import { promptUploadIdSchema } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  buildPromptUploadObjectKey,
  detectPromptUploadFileType,
  isMultipartFile,
  isSupportedPromptUploadMimeType,
  PROMPT_UPLOAD_IMAGE_MAX_BYTES,
  promptUploadRequestExceedsLimit,
} from "../media";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { streamStoredMedia } from "./stream-stored-media";
import { PromptUploadCoordinator } from "./prompt-upload-coordinator";

const logger = createLogger("router:session-uploads");

async function handleUploadPost(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  if (promptUploadRequestExceedsLimit(request)) {
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

  if (fileEntry.type && !isSupportedPromptUploadMimeType(fileEntry.type)) {
    return error("Unsupported attachment MIME type", 400);
  }

  if (fileEntry.size > PROMPT_UPLOAD_IMAGE_MAX_BYTES) {
    return error(`Images must be ${PROMPT_UPLOAD_IMAGE_MAX_BYTES} bytes or smaller`, 400);
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const detected = detectPromptUploadFileType(bytes);
  if (!detected) {
    return error("Uploaded file is not a supported image format", 400);
  }

  if (bytes.byteLength > PROMPT_UPLOAD_IMAGE_MAX_BYTES) {
    return error(`Images must be ${PROMPT_UPLOAD_IMAGE_MAX_BYTES} bytes or smaller`, 400);
  }

  if (fileEntry.type && fileEntry.type !== detected.mimeType) {
    return error("Uploaded file MIME type does not match file contents", 400);
  }

  const uploadId = generateId();
  const objectKey = buildPromptUploadObjectKey(sessionId, uploadId);
  const storage = createMediaObjectStorage(env);
  const coordinator = new PromptUploadCoordinator(ctx.sessionRuntime, storage, sessionId, logger, {
    requestId: ctx.request_id,
    traceId: ctx.trace_id,
  });
  const stored = await coordinator.store(bytes, {
    uploadId,
    mimeType: detected.mimeType,
    sizeBytes: bytes.byteLength,
    objectKey,
  });
  if (!stored.ok) return error(stored.error, stored.status);

  logger.info("uploads.stored", {
    session_id: sessionId,
    upload_id: uploadId,
    mime_type: detected.mimeType,
    size_bytes: bytes.byteLength,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ uploadId, mimeType: detected.mimeType }, 201);
}

async function handleUploadGet(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const uploadId = match.groups?.uploadId;
  if (!sessionId || !uploadId) {
    return error("Session ID and upload ID are required", 400);
  }
  if (!promptUploadIdSchema.safeParse(uploadId).success) {
    return error("Invalid upload ID", 400);
  }

  const storage = createMediaObjectStorage(env);
  const objectKey = buildPromptUploadObjectKey(sessionId, uploadId);

  return streamStoredMedia({
    request,
    storage,
    objectKey,
    isAllowedContentType: isSupportedPromptUploadMimeType,
    notFound: () => error("Upload not found", 404),
    invalidMetadata: (contentType) => {
      logger.error("uploads.invalid_metadata", {
        session_id: sessionId,
        upload_id: uploadId,
        content_type: contentType,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Upload is invalid", 500);
    },
  });
}

export const sessionUploadRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/uploads"),
    handler: handleUploadPost,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/uploads/:uploadId"),
    handler: handleUploadGet,
  }),
];
