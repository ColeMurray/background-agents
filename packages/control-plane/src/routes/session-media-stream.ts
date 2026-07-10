import { createLogger } from "../logger";
import { isSupportedScreenshotMimeType, isSupportedVideoMimeType } from "../media";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { ArtifactResponse, Env } from "../types";
import { getSessionArtifactFromRuntime } from "./session-media-artifacts";
import { error, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";
import { streamStoredMedia } from "./stream-stored-media";
export { parseByteRangeHeader } from "./stream-stored-media";

const logger = createLogger("router:session-media");

function getMediaMimeType(
  artifact: Pick<ArtifactResponse, "metadata">
): "image/png" | "image/jpeg" | "image/webp" | "video/mp4" | null {
  const mimeType = artifact.metadata?.mimeType;
  if (typeof mimeType !== "string") return null;
  if (isSupportedScreenshotMimeType(mimeType) || isSupportedVideoMimeType(mimeType)) {
    return mimeType;
  }
  return null;
}

async function handleMediaGet(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const artifactId = match.groups?.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  const storage = createMediaObjectStorage(env);
  if (!/^[A-Za-z0-9-]+$/.test(artifactId)) {
    return error("Invalid artifact ID", 400);
  }

  const artifact = await getSessionArtifactFromRuntime(sessionId, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || (artifact.type !== "screenshot" && artifact.type !== "video") || !artifact.url) {
    return error("Media artifact not found", 404);
  }

  return streamStoredMedia({
    request,
    storage,
    objectKey: artifact.url,
    fallbackContentType: getMediaMimeType(artifact),
    isAllowedContentType: (contentType) =>
      isSupportedScreenshotMimeType(contentType) || isSupportedVideoMimeType(contentType),
    notFound: () => {
      logger.warn("media.stream.object_missing", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact not found", 404);
    },
    invalidMetadata: () => {
      logger.error("media.stream.invalid_metadata", {
        session_id: sessionId,
        artifact_id: artifactId,
        object_key: artifact.url,
        request_id: ctx.request_id,
        trace_id: ctx.trace_id,
      });
      return error("Media artifact is invalid", 500);
    },
  });
}

export const sessionMediaStreamRoutes: Route[] = [
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/media/:artifactId"),
    handler: handleMediaGet,
  }),
];
