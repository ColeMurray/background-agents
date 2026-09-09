import { Hono } from "hono";
import { admit } from "../routing/admit";
import type { ControlPlaneHonoEnv } from "../routing/hono-env";
import { createLogger } from "../logger";
import { isSupportedScreenshotMimeType, isSupportedVideoMimeType } from "../media";
import type { NormalizedArtifactResponse } from "../session/artifacts";
import type { ObjectStorageMetadata } from "../storage/object-storage";
import type { Env } from "../types";
import { parseByteRangeHeader, type ByteRange } from "./requests/byte-range";
import {
  createPartialStoredObjectResponse,
  createRangeNotSatisfiableResponse,
  createStoredObjectResponse,
} from "./responses/stored-object-response";
import { getSessionArtifactFromRuntime } from "./session-media-artifacts";
import { error, GITHUB_USER_OR_SERVICE_ROUTE, requirePermission } from "./shared";
import { type SessionRouteContext, dispatchSession } from "./session-route";
const logger = createLogger("router:session-media");

function getMediaMimeType(
  artifact: NormalizedArtifactResponse
): "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | null {
  const mimeType = artifact.metadata?.mimeType;
  if (typeof mimeType !== "string") return null;
  if (isSupportedScreenshotMimeType(mimeType) || isSupportedVideoMimeType(mimeType)) {
    return mimeType;
  }
  return null;
}

function getStoredContentType(metadata: ObjectStorageMetadata): string | null {
  const headers = new Headers();
  metadata.writeHttpMetadata(headers);
  return headers.get("Content-Type");
}

function resolveMediaContentType(
  artifact: NormalizedArtifactResponse,
  metadata: ObjectStorageMetadata
): string | null {
  const storedContentType = getStoredContentType(metadata);
  if (
    storedContentType &&
    (isSupportedScreenshotMimeType(storedContentType) ||
      isSupportedVideoMimeType(storedContentType))
  ) {
    return storedContentType;
  }
  return getMediaMimeType(artifact);
}

export async function handleMediaGet(
  request: Request,
  env: Env,
  params: { id: string; artifactId: string },
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = params.id;
  const artifactId = params.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  const storage = env.MEDIA_BUCKET;
  if (!/^[A-Za-z0-9-]+$/.test(artifactId)) {
    return error("Invalid artifact ID", 400);
  }

  const artifact = await getSessionArtifactFromRuntime(sessionId, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || (artifact.type !== "screenshot" && artifact.type !== "video") || !artifact.url) {
    return error("Media artifact not found", 404);
  }
  const rangeHeader = request.headers.get("Range");
  let body: ReadableStream;
  let metadata: ObjectStorageMetadata;
  let range: ByteRange | null = null;

  if (rangeHeader) {
    const head = await storage.head(artifact.url);
    if (!head) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }
    range = parseByteRangeHeader(rangeHeader, head.size);
    if (!range) return createRangeNotSatisfiableResponse(head.size);

    const object = await storage.get(artifact.url, {
      range: { offset: range.start, length: range.length },
    });
    if (!object) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }
    body = object.body;
    metadata = head;
  } else {
    const object = await storage.get(artifact.url);
    if (!object) {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    }
    body = object.body;
    metadata = object;
  }

  const contentType = resolveMediaContentType(artifact, metadata);
  if (!contentType) {
    logger.error("media.stream.invalid_metadata", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: artifact.url,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
    });
    return error("Media artifact is invalid", 500);
  }

  return range
    ? createPartialStoredObjectResponse(body, metadata, contentType, range)
    : createStoredObjectResponse(body, metadata, contentType);
}

export const sessionMediaStreamRoutes = new Hono<ControlPlaneHonoEnv>();

sessionMediaStreamRoutes.get(
  "/sessions/:id/media/:artifactId",
  admit({
    ...GITHUB_USER_OR_SERVICE_ROUTE,
    authorization: requirePermission("sessions.read", {
      actorlessGrants: [{ service: "slack-bot" }],
    }),
  }),
  (c) => dispatchSession(c, handleMediaGet)
);
