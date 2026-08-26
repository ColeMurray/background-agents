import {
  listArtifactsResponseSchema,
  sessionArtifactSchema,
  type ScreenshotArtifactMetadata,
  type SessionArtifact,
  type VideoArtifactMetadata,
} from "@open-inspect/shared/types/artifacts";
import { z } from "zod";
import { createLogger } from "../logger";
import type { NormalizedArtifactResponse } from "../session/artifacts";
import { SessionInternalPaths } from "../session/contracts";
import type { ObjectStorage } from "../storage/object-storage";
import { error } from "./shared";
import type { SessionRouteContext } from "./session-route";

const logger = createLogger("router:session-media");

const getArtifactResponseSchema = z.object({
  artifact: sessionArtifactSchema.nullable(),
});

/**
 * Reads a runtime response body as JSON, normalizing empty/non-JSON bodies to
 * `null` so the schema boundary below rejects them instead of throwing.
 */
async function readJsonBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/**
 * The runtime omits `updatedAt` on artifacts written before PR lifecycle
 * tracking, so fall back to `createdAt` (the documented consumer rule) rather
 * than rejecting the response.
 */
function toArtifactResponse(artifact: SessionArtifact): NormalizedArtifactResponse {
  return { ...artifact, updatedAt: artifact.updatedAt ?? artifact.createdAt };
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  const responseText = await response.text();
  if (!responseText) return fallback;

  try {
    const parsedError: unknown = JSON.parse(responseText);
    if (typeof parsedError === "object" && parsedError !== null && "error" in parsedError) {
      const errorMessage = parsedError.error;
      if (typeof errorMessage === "string" && errorMessage.trim()) {
        return errorMessage;
      }
    }
  } catch {
    // Fall through to raw response text.
  }

  return responseText;
}

export async function persistMediaArtifact(input: {
  sessionId: string;
  artifactId: string;
  artifactType: "screenshot" | "video";
  objectKey: string;
  metadata: ScreenshotArtifactMetadata | VideoArtifactMetadata;
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
    return error("Failed to persist media artifact", 500);
  }

  logger.warn("media.upload.create_artifact_failed", logData);
  return error(doErrorMessage, createArtifactResponse.status);
}

export async function listSessionArtifactsFromRuntime(
  sessionId: string,
  ctx: SessionRouteContext
): Promise<NormalizedArtifactResponse[] | Response> {
  const response = await ctx.sessionRuntime.fetch(sessionId, SessionInternalPaths.artifacts);
  if (!response.ok) {
    return response.status === 404
      ? error("Session not found", 404)
      : error("Failed to list session artifacts", 500);
  }

  const parsed = listArtifactsResponseSchema.safeParse(await readJsonBody(response));
  if (!parsed.success) return error("Failed to list session artifacts", 500);
  return parsed.data.artifacts.map(toArtifactResponse);
}

export async function getSessionArtifactFromRuntime(
  sessionId: string,
  artifactId: string,
  ctx: SessionRouteContext
): Promise<NormalizedArtifactResponse | null | Response> {
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

  const parsed = getArtifactResponseSchema.safeParse(await readJsonBody(response));
  if (!parsed.success) return error("Failed to fetch session artifact", 500);
  return parsed.data.artifact ? toArtifactResponse(parsed.data.artifact) : null;
}
