import type {
  FileArtifactMetadata,
  ScreenshotArtifactMetadata,
  VideoArtifactMetadata,
} from "@open-inspect/shared";
import { createLogger } from "../logger";
import { SessionInternalPaths } from "../session/contracts";
import type { ObjectStorage } from "../storage/object-storage";
import type { ArtifactResponse } from "../types";
import { error } from "./shared";
import type { SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-media");

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  const responseText = await response.text();
  if (!responseText) return fallback;

  try {
    const parsedError = JSON.parse(responseText) as { error?: unknown };
    if (typeof parsedError.error === "string" && parsedError.error.trim()) {
      return parsedError.error;
    }
  } catch {
    // Fall through to raw response text.
  }

  return responseText;
}

export async function persistMediaArtifact(input: {
  sessionId: string;
  artifactId: string;
  artifactType: "screenshot" | "video" | "file";
  objectKey: string;
  metadata: ScreenshotArtifactMetadata | VideoArtifactMetadata | FileArtifactMetadata;
  storage: ObjectStorage;
  ctx: SessionRouteContext;
  parseFallback: string;
}): Promise<Response | null> {
  const { sessionId, artifactId, artifactType, objectKey, metadata, storage, ctx, parseFallback } =
    input;
  const createArtifactResponse = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.createMediaArtifact,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactId,
        artifactType,
        objectKey,
        metadata,
      }),
    }
  );

  if (createArtifactResponse.ok) return null;

  try {
    await storage.delete(objectKey);
  } catch (cleanupError) {
    logger.error("media.upload.cleanup_failed", {
      session_id: sessionId,
      artifact_id: artifactId,
      object_key: objectKey,
      request_id: ctx.request_id,
      trace_id: ctx.trace_id,
      error: cleanupError instanceof Error ? cleanupError : String(cleanupError),
    });
  }

  const doErrorMessage = await parseErrorMessage(createArtifactResponse, parseFallback);
  const logData = {
    session_id: sessionId,
    artifact_id: artifactId,
    request_id: ctx.request_id,
    trace_id: ctx.trace_id,
    error: doErrorMessage,
    http_status: createArtifactResponse.status,
  };

  if (createArtifactResponse.status >= 500) {
    logger.error("media.upload.create_artifact_failed", logData);
    return error(parseFallback, 500);
  }

  logger.warn("media.upload.create_artifact_failed", logData);
  return error(doErrorMessage, createArtifactResponse.status);
}

export async function listSessionArtifactsFromRuntime(
  sessionId: string,
  ctx: SessionRouteContext
): Promise<ArtifactResponse[] | Response> {
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.artifacts);
  if (!response.ok) {
    return response.status === 404
      ? error("Session not found", 404)
      : error("Failed to list session artifacts", 500);
  }

  const data = (await response.json()) as { artifacts: ArtifactResponse[] };
  return data.artifacts;
}

export async function getSessionArtifactFromRuntime(
  sessionId: string,
  artifactId: string,
  ctx: SessionRouteContext
): Promise<ArtifactResponse | null | Response> {
  const response = await ctx.sessionRuntime.fetch(
    sessionId,
    SessionInternalPaths.artifacts,
    undefined,
    `?artifactId=${encodeURIComponent(artifactId)}`
  );
  if (!response.ok) {
    return response.status === 404
      ? error("Session not found", 404)
      : error("Failed to fetch session artifact", 500);
  }

  const data = (await response.json()) as { artifact: ArtifactResponse | null };
  return data.artifact;
}
