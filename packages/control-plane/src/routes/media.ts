/**
 * Media upload/download routes.
 *
 * POST /api/media/upload — upload binary content to R2, returns { key, url }
 * GET  /api/media/:key   — proxy R2 object with cache headers
 */

import { R2MediaService } from "../media/r2-media-service";
import { createLogger } from "../logger";
import type { Env } from "../types";
import { type Route, type RequestContext, parsePattern, json, error } from "./shared";

const logger = createLogger("router:media");

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

function getMediaService(env: Env): R2MediaService | null {
  if (!env.MEDIA_BUCKET) return null;
  return new R2MediaService(env.MEDIA_BUCKET);
}

async function handleUpload(
  request: Request,
  env: Env,
  _match: RegExpMatchArray,
  ctx: RequestContext
): Promise<Response> {
  const media = getMediaService(env);
  if (!media) {
    return error("Media storage not configured", 503);
  }

  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  const filename = request.headers.get("x-filename") ?? "upload";
  const sessionId = request.headers.get("x-session-id");

  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_UPLOAD_SIZE) {
    return error("File too large (max 10 MB)", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_UPLOAD_SIZE) {
    return error("File too large (max 10 MB)", 413);
  }

  const ext = extFromMime(contentType) || extFromFilename(filename);
  const id = crypto.randomUUID();
  const prefix = sessionId ? `${sessionId}/` : "";
  const key = `${prefix}${id}${ext}`;

  await media.upload(key, body, contentType);

  const workerUrl = env.WORKER_URL ?? "";
  const url = `${workerUrl}/api/media/${encodeURIComponent(key)}`;

  logger.info("media_uploaded", {
    event: "media.uploaded",
    key,
    contentType,
    size: body.byteLength,
    request_id: ctx.request_id,
  });

  return json({ key, url }, 201);
}

async function handleDownload(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  _ctx: RequestContext
): Promise<Response> {
  const media = getMediaService(env);
  if (!media) {
    return error("Media storage not configured", 503);
  }

  const key = match.groups?.key;
  if (!key) {
    return error("Missing key", 400);
  }

  const decodedKey = decodeURIComponent(key);
  const result = await media.get(decodedKey);
  if (!result) {
    return error("Not found", 404);
  }

  return new Response(result.body, {
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": "public, max-age=86400, immutable",
    },
  });
}

export const mediaRoutes: Route[] = [
  {
    method: "POST",
    pattern: parsePattern("/api/media/upload"),
    handler: handleUpload,
  },
  {
    method: "GET",
    pattern: parsePattern("/api/media/:key"),
    handler: handleDownload,
  },
];

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "application/pdf": ".pdf",
    "text/plain": ".txt",
    "application/json": ".json",
  };
  return map[mime] ?? "";
}

function extFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return "";
  return filename.slice(dot);
}
