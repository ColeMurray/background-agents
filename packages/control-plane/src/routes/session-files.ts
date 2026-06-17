import type { FileArtifactMetadata } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import {
  buildFileArtifactObjectKey,
  FILE_ARTIFACT_ID_PATTERN,
  inferFileArtifactMimeType,
  sanitizeFileArtifactFilename,
  validateFileArtifactSize,
} from "../file-artifacts";
import { isMultipartFile } from "../media";
import { createMediaObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { getSessionArtifactFromRuntime, persistMediaArtifact } from "./session-media-artifacts";
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
  return "artifact";
}

function getOptionalFormString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function handleFileUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
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

  const sizeError = validateFileArtifactSize(fileEntry.size);
  if (sizeError) return error(sizeError, 400);

  const filename = sanitizeFileArtifactFilename(getMultipartFilename(fileEntry));
  if (!filename) {
    return error("File artifact filename is required", 400);
  }

  const mimeType = inferFileArtifactMimeType(filename, fileEntry.type);
  if (!mimeType) {
    return error("Unsupported file artifact type", 400);
  }

  const caption = getOptionalFormString(formData.get("caption"));
  const artifactId = generateId();
  const objectKey = buildFileArtifactObjectKey(sessionId, artifactId, filename);
  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const metadata: FileArtifactMetadata = {
    objectKey,
    filename,
    mimeType,
    sizeBytes: bytes.byteLength,
    ...(caption ? { caption } : {}),
  };

  const storage = createMediaObjectStorage(env);
  await storage.put(objectKey, bytes, { contentType: mimeType });

  const persistError = await persistMediaArtifact({
    sessionId,
    artifactId,
    artifactType: "file",
    objectKey,
    metadata,
    storage,
    ctx,
    parseFallback: "Failed to persist file artifact",
  });
  if (persistError) return persistError;

  return json({ artifactId, objectKey, filename }, 201);
}

async function handleFileDownload(
  _request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  const artifactId = match.groups?.artifactId;
  if (!sessionId || !artifactId) {
    return error("Session ID and artifact ID are required", 400);
  }
  if (!FILE_ARTIFACT_ID_PATTERN.test(artifactId)) {
    return error("Invalid artifact ID", 400);
  }

  const artifact = await getSessionArtifactFromRuntime(sessionId, artifactId, ctx);
  if (artifact instanceof Response) return artifact;
  if (!artifact || artifact.type !== "file" || !artifact.url) {
    return error("File artifact not found", 404);
  }

  const metadata = artifact.metadata ?? {};
  const filename =
    typeof metadata.filename === "string"
      ? sanitizeFileArtifactFilename(metadata.filename)
      : sanitizeFileArtifactFilename(artifactId);
  if (!filename) {
    return error("File artifact metadata is invalid", 500);
  }

  const storage = createMediaObjectStorage(env);
  const object = await storage.get(artifact.url);
  if (!object) {
    return error("File artifact not found", 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (typeof metadata.mimeType === "string" && metadata.mimeType.trim()) {
    headers.set("Content-Type", metadata.mimeType);
  }
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Content-Disposition", `attachment; filename="${filename.replaceAll('"', "")}"`);
  headers.set("Cache-Control", "private, no-store");

  return new Response(object.body, { headers });
}

export const sessionFileRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/files"),
    handler: handleFileUpload,
  }),
  sessionRoute({
    method: "GET",
    pattern: parsePattern("/sessions/:id/files/:artifactId"),
    handler: handleFileDownload,
  }),
];
