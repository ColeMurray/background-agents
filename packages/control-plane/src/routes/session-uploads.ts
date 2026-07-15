/**
 * User-attached prompt images (chat composer attachments).
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
} from "../media";
import { SessionInternalPaths } from "../session/contracts";
import { createMediaObjectStorage, type ObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { streamStoredMedia } from "./stream-stored-media";

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
  await storage.put(objectKey, bytes, { contentType: detected.mimeType });

  // Register the upload with the session DO so it is tracked and quota-governed.
  // On rejection (unknown session, quota exceeded) remove the object again.
  const recordResponse = await recordTrackedUpload(ctx, storage, sessionId, {
    uploadId,
    kind: detected.kind,
    mimeType: detected.mimeType,
    sizeBytes: bytes.byteLength,
    objectKey,
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

interface UploadRecordRequest {
  uploadId: string;
  kind: "image";
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
}

interface StaleUploadClaim {
  uploadId: string;
  objectKey: string;
}

async function recordTrackedUpload(
  ctx: SessionRouteContext,
  storage: ObjectStorage,
  sessionId: string,
  record: UploadRecordRequest
): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.uploads, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (!response.ok) return response;

    const body = (await response.json()) as {
      status?: string;
      staleUploads?: StaleUploadClaim[];
    };
    if (body.status !== "cleanup_required") {
      return Response.json(body, { status: response.status });
    }

    const cleanup = await deleteClaimedUploadObjects(
      storage,
      body.staleUploads ?? [],
      sessionId,
      ctx
    );
    const completion = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.uploads, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "complete_cleanup",
        acknowledgedUploadIds: cleanup.acknowledgedUploadIds,
        releasedUploadIds: cleanup.releasedUploadIds,
      }),
    });
    if (!completion.ok) return completion;
    if (cleanup.releasedUploadIds.length > 0) {
      return Response.json(
        { error: "Failed to clean up expired uploads; please retry" },
        { status: 503 }
      );
    }
  }
  return Response.json({ error: "Upload cleanup did not converge; please retry" }, { status: 503 });
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

async function deleteClaimedUploadObjects(
  storage: ObjectStorage,
  uploads: StaleUploadClaim[],
  sessionId: string,
  ctx: SessionRouteContext
): Promise<{ acknowledgedUploadIds: string[]; releasedUploadIds: string[] }> {
  const results = await Promise.allSettled(
    uploads.map((upload) => storage.delete(upload.objectKey))
  );
  const acknowledgedUploadIds: string[] = [];
  const releasedUploadIds: string[] = [];
  results.forEach((result, index) => {
    const uploadId = uploads[index]?.uploadId;
    if (!uploadId) return;
    if (result.status === "fulfilled") acknowledgedUploadIds.push(uploadId);
    else releasedUploadIds.push(uploadId);
  });
  logger.info("uploads.pruned_stale_objects", {
    session_id: sessionId,
    deleted: acknowledgedUploadIds.length,
    failed: releasedUploadIds.length,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
  });
  return { acknowledgedUploadIds, releasedUploadIds };
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
