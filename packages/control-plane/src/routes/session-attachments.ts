import type { Attachment } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import {
  ATTACHMENT_ID_PATTERN,
  attachmentTypeFromMimeType,
  buildAttachmentDownloadUrl,
  buildAttachmentObjectKey,
  inferAttachmentMimeType,
  sanitizeAttachmentFilename,
  validateAttachmentSize,
} from "../attachments";
import { isMultipartFile } from "../media";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

function getMultipartFilename(fileEntry: unknown): string {
  if (
    fileEntry &&
    typeof fileEntry === "object" &&
    typeof (fileEntry as { name?: unknown }).name === "string"
  ) {
    return (fileEntry as { name: string }).name;
  }
  return "attachment";
}

async function handleAttachmentUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required", 400);

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

  const sizeError = validateAttachmentSize(fileEntry.size);
  if (sizeError) return error(sizeError, 400);

  const filename = sanitizeAttachmentFilename(getMultipartFilename(fileEntry));
  if (!filename) {
    return error("Attachment filename is required", 400);
  }

  const mimeType = inferAttachmentMimeType(filename, fileEntry.type);
  if (!mimeType) {
    return error("Unsupported attachment file type", 400);
  }

  const attachmentId = generateId();
  const objectKey = buildAttachmentObjectKey(sessionId, attachmentId, filename);
  const bytes = new Uint8Array(await fileEntry.arrayBuffer());

  await createMediaObjectStorage(env).put(objectKey, bytes, { contentType: mimeType });

  const attachment: Attachment = {
    id: attachmentId,
    type: attachmentTypeFromMimeType(mimeType),
    name: filename,
    url: buildAttachmentDownloadUrl(sessionId, attachmentId, filename),
    mimeType,
    sizeBytes: bytes.byteLength,
    objectKey,
  };

  return json({ attachment }, 201);
}

async function handleAttachmentDownload(
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
  if (!ATTACHMENT_ID_PATTERN.test(attachmentId)) {
    return error("Invalid attachment ID", 400);
  }

  const requestedFilename = new URL(request.url).searchParams.get("filename");
  const filename = requestedFilename ? sanitizeAttachmentFilename(requestedFilename) : null;
  if (!filename || filename !== requestedFilename) {
    return error("Invalid attachment filename", 400);
  }

  const mimeType = inferAttachmentMimeType(filename);
  if (!mimeType) {
    return error("Unsupported attachment file type", 400);
  }

  const objectKey = buildAttachmentObjectKey(sessionId, attachmentId, filename);
  const object = await createMediaObjectStorage(env).get(objectKey);
  if (!object) {
    return error("Attachment not found", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", headers.get("Content-Type") ?? mimeType);
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Disposition", `attachment; filename="${filename.replaceAll('"', "")}"`);
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("x-request-id", ctx.request_id);
  headers.set("x-trace-id", ctx.trace_id);

  return new Response(object.body, { headers });
}

export const sessionAttachmentRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/attachments"),
    handler: handleAttachmentUpload,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/attachments/:attachmentId"),
    handler: handleAttachmentDownload,
  }),
];
