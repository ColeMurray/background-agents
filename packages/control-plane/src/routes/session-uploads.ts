/**
 * User-attached prompt media (chat composer attachments).
 *
 * POST stores the file in the media bucket keyed by an unguessable upload id;
 * the prompt then references it as `{ uploadId }` so the message row and
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

import { generateId } from "../auth/crypto";
import { createLogger } from "../logger";
import {
  buildPromptUploadObjectKey,
  detectPromptUploadFileType,
  isMultipartFile,
  isSupportedPromptUploadMimeType,
  PROMPT_UPLOAD_IMAGE_MAX_BYTES,
  PROMPT_UPLOAD_VIDEO_MAX_BYTES,
} from "../media";
import { SessionInternalPaths } from "../session/contracts";
import { createMediaObjectStorage, type ObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { parseByteRangeHeader } from "./session-media-stream";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-uploads");

async function handleUploadPost(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");

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

  if (fileEntry.size > PROMPT_UPLOAD_VIDEO_MAX_BYTES) {
    return error(`Attachments must be ${PROMPT_UPLOAD_VIDEO_MAX_BYTES} bytes or smaller`, 400);
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const detected = detectPromptUploadFileType(bytes);
  if (!detected) {
    return error("Uploaded file is not a supported image or video format", 400);
  }

  const maxBytes =
    detected.kind === "image" ? PROMPT_UPLOAD_IMAGE_MAX_BYTES : PROMPT_UPLOAD_VIDEO_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    return error(`${detected.kind} attachments must be ${maxBytes} bytes or smaller`, 400);
  }

  if (fileEntry.type && fileEntry.type !== detected.mimeType) {
    return error("Uploaded file MIME type does not match file contents", 400);
  }

  const uploadId = generateId();
  const objectKey = buildPromptUploadObjectKey(sessionId, uploadId);
  const storage = createMediaObjectStorage(env);
  await storage.put(objectKey, bytes, { contentType: detected.mimeType });

  // Register the upload with the session DO so it is tracked and quota-governed.
  // On rejection (unknown session, quota exceeded) remove the object again.
  const recordResponse = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.uploads, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      uploadId,
      kind: detected.kind,
      mimeType: detected.mimeType,
      sizeBytes: bytes.byteLength,
      objectKey,
    }),
  });

  if (!recordResponse.ok) {
    try {
      await storage.delete(objectKey);
    } catch (cleanupError) {
      logger.error("uploads.cleanup_failed", {
        session_id: sessionId,
        upload_id: uploadId,
        object_key: objectKey,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
        error: cleanupError instanceof Error ? cleanupError : String(cleanupError),
      });
    }
    const message = await parseUploadError(recordResponse);
    return error(message, recordResponse.status);
  }

  const record = (await recordResponse.json()) as { staleObjectKeys?: string[] };
  const staleObjectKeys = record.staleObjectKeys ?? [];
  if (staleObjectKeys.length > 0) {
    const prune = deleteStaleUploadObjects(storage, staleObjectKeys, sessionId, ctx);
    if (ctx.executionCtx) {
      ctx.executionCtx.waitUntil(prune);
    } else {
      await prune;
    }
  }

  logger.info("uploads.stored", {
    session_id: sessionId,
    upload_id: uploadId,
    mime_type: detected.mimeType,
    size_bytes: bytes.byteLength,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });

  return json({ uploadId, kind: detected.kind, mimeType: detected.mimeType }, 201);
}

async function parseUploadError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error;
    }
  } catch {
    // Fall through to the generic message.
  }
  return response.status === 404 ? "Session not found" : "Failed to record upload";
}

async function deleteStaleUploadObjects(
  storage: ObjectStorage,
  objectKeys: string[],
  sessionId: string,
  ctx: SessionRouteContext
): Promise<void> {
  const results = await Promise.allSettled(objectKeys.map((key) => storage.delete(key)));
  const failed = results.filter((result) => result.status === "rejected").length;
  logger.info("uploads.pruned_stale_objects", {
    session_id: sessionId,
    deleted: objectKeys.length - failed,
    failed,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
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
  if (!/^[A-Za-z0-9-]+$/.test(uploadId)) {
    return error("Invalid upload ID", 400);
  }

  const storage = createMediaObjectStorage(env);
  const objectKey = buildPromptUploadObjectKey(sessionId, uploadId);

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    const head = await storage.head(objectKey);
    if (!head) return error("Upload not found", 404);

    const parsedRange = parseByteRangeHeader(rangeHeader, head.size);
    if (parsedRange instanceof Response) return parsedRange;

    const rangedObject = await storage.get(objectKey, {
      range: { offset: parsedRange.start, length: parsedRange.length },
    });
    if (!rangedObject) return error("Upload not found", 404);

    const headers = buildUploadHeaders(head, sessionId, uploadId, ctx);
    if (headers instanceof Response) return headers;
    headers.set("Content-Range", `bytes ${parsedRange.start}-${parsedRange.end}/${head.size}`);
    headers.set("Content-Length", String(parsedRange.length));
    return new Response(rangedObject.body, { status: 206, headers });
  }

  const object = await storage.get(objectKey);
  if (!object) return error("Upload not found", 404);

  const headers = buildUploadHeaders(object, sessionId, uploadId, ctx);
  if (headers instanceof Response) return headers;
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}

function buildUploadHeaders(
  source: { writeHttpMetadata(headers: Headers): void; httpEtag: string },
  sessionId: string,
  uploadId: string,
  ctx: SessionRouteContext
): Headers | Response {
  const headers = new Headers();
  source.writeHttpMetadata(headers);
  const contentType = headers.get("Content-Type");
  if (!contentType || !isSupportedPromptUploadMimeType(contentType)) {
    logger.error("uploads.invalid_metadata", {
      session_id: sessionId,
      upload_id: uploadId,
      content_type: contentType,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Upload is invalid", 500);
  }
  headers.set("Content-Type", contentType);
  headers.set("ETag", source.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  return headers;
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
