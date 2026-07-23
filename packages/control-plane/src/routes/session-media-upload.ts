import type { ScreenshotArtifactMetadata, VideoArtifactMetadata } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import {
  buildMediaObjectKey,
  detectScreenshotFileType,
  detectVideoFileType,
  isMultipartFile,
  isSupportedVideoMimeType,
  parseDimensions,
  parseOptionalBoolean,
  parseVideoUploadMetadata,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_UPLOAD_LIMIT_PER_SESSION,
  VIDEO_MAX_BYTES,
  VIDEO_UPLOAD_LIMIT_PER_SESSION,
  type MultipartFieldValue,
} from "../media";
import { createMediaObjectStorage, type ObjectStorage } from "../storage/object-storage";
import type { Env } from "../types";
import { listSessionArtifactsFromRuntime, persistMediaArtifact } from "./session-media-artifacts";
import { error, json, parsePattern, type Route } from "./shared";
import { sessionRoute, type SessionRouteContext } from "./session-route";

function getRequiredFormString(value: MultipartFieldValue | null, name: string): string | Response {
  if (typeof value !== "string" || value.trim().length === 0) {
    return error(`${name} is required`, 400);
  }

  return value.trim();
}

function getOptionalFormString(value: MultipartFieldValue | null): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

async function handleMediaUpload(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
  ctx: SessionRouteContext
): Promise<Response> {
  const sessionId = match.groups?.id;
  if (!sessionId) return error("Session ID required");
  const storage = createMediaObjectStorage(env);

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

  const artifactTypeField = getRequiredFormString(formData.get("artifactType"), "artifactType");
  if (artifactTypeField instanceof Response) return artifactTypeField;
  if (artifactTypeField === "video") {
    return handleVideoUpload({ sessionId, formData, fileEntry, storage, ctx });
  }
  if (artifactTypeField !== "screenshot") {
    return error("Only screenshot and video uploads are supported", 400);
  }

  if (fileEntry.size <= 0) {
    return error("Uploaded file is empty", 400);
  }

  if (fileEntry.size > SCREENSHOT_MAX_BYTES) {
    return error(`Screenshot uploads must be ${SCREENSHOT_MAX_BYTES} bytes or smaller`, 400);
  }

  if (
    fileEntry.type &&
    fileEntry.type !== "image/png" &&
    fileEntry.type !== "image/jpeg" &&
    fileEntry.type !== "image/webp"
  ) {
    return error("Unsupported screenshot MIME type", 400);
  }

  let fullPage: boolean | undefined;
  let annotated: boolean | undefined;
  let viewport: { width: number; height: number } | undefined;
  try {
    fullPage = parseOptionalBoolean(formData.get("fullPage"));
    annotated = parseOptionalBoolean(formData.get("annotated"));
    viewport = parseDimensions(formData.get("viewport"), {
      name: "viewport",
      required: false,
      mode: "round",
    });
  } catch (fieldError) {
    return error(
      fieldError instanceof Error ? fieldError.message : "Invalid screenshot metadata",
      400
    );
  }

  const caption = getOptionalFormString(formData.get("caption"));
  const sourceUrl = getOptionalFormString(formData.get("sourceUrl"));
  if (sourceUrl) {
    try {
      new URL(sourceUrl);
    } catch {
      return error("sourceUrl must be a valid URL", 400);
    }
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const detectedFileType = detectScreenshotFileType(bytes);
  if (!detectedFileType) {
    return error("Uploaded file is not a supported screenshot format", 400);
  }

  if (fileEntry.type && fileEntry.type !== detectedFileType.mimeType) {
    return error("Uploaded file MIME type does not match file contents", 400);
  }

  const artifactsResult = await listSessionArtifactsFromRuntime(sessionId, ctx);
  if (artifactsResult instanceof Response) return artifactsResult;

  const screenshotCount = artifactsResult.filter(
    (artifact) => artifact.type === "screenshot"
  ).length;
  if (screenshotCount >= SCREENSHOT_UPLOAD_LIMIT_PER_SESSION) {
    return error(
      `Session screenshot limit of ${SCREENSHOT_UPLOAD_LIMIT_PER_SESSION} uploads exceeded`,
      429
    );
  }

  const artifactId = generateId();
  const objectKey = buildMediaObjectKey(sessionId, artifactId, detectedFileType.extension);
  const metadata: ScreenshotArtifactMetadata = {
    objectKey,
    mimeType: detectedFileType.mimeType,
    sizeBytes: bytes.byteLength,
    ...(viewport ? { viewport } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(fullPage !== undefined ? { fullPage } : {}),
    ...(annotated !== undefined ? { annotated } : {}),
    ...(caption ? { caption } : {}),
  };

  await storage.put(objectKey, bytes, { contentType: detectedFileType.mimeType });

  const persistError = await persistMediaArtifact({
    sessionId,
    artifactId,
    artifactType: "screenshot",
    objectKey,
    metadata,
    storage,
    ctx,
    parseFallback: "Failed to persist media artifact",
  });
  if (persistError) return persistError;

  return json({ artifactId, objectKey }, 201);
}

async function handleVideoUpload(input: {
  sessionId: string;
  formData: FormData;
  fileEntry: Exclude<MultipartFieldValue, string>;
  storage: ObjectStorage;
  ctx: SessionRouteContext;
}): Promise<Response> {
  const { sessionId, formData, fileEntry, storage, ctx } = input;

  if (fileEntry.size <= 0) {
    return error("Uploaded file is empty", 400);
  }

  if (fileEntry.size > VIDEO_MAX_BYTES) {
    return error(`Video uploads must be ${VIDEO_MAX_BYTES} bytes or smaller`, 400);
  }

  if (fileEntry.type && !isSupportedVideoMimeType(fileEntry.type)) {
    return error("Unsupported video MIME type", 400);
  }

  const artifactsResult = await listSessionArtifactsFromRuntime(sessionId, ctx);
  if (artifactsResult instanceof Response) return artifactsResult;

  const videoCount = artifactsResult.filter((artifact) => artifact.type === "video").length;
  if (videoCount >= VIDEO_UPLOAD_LIMIT_PER_SESSION) {
    return error(`Session video limit of ${VIDEO_UPLOAD_LIMIT_PER_SESSION} uploads exceeded`, 429);
  }

  let uploadMetadata: ReturnType<typeof parseVideoUploadMetadata>;
  try {
    uploadMetadata = parseVideoUploadMetadata(formData);
  } catch (fieldError) {
    return error(fieldError instanceof Error ? fieldError.message : "Invalid video metadata", 400);
  }

  const bytes = new Uint8Array(await fileEntry.arrayBuffer());
  const detectedFileType = detectVideoFileType(bytes);
  if (!detectedFileType) {
    return error("Uploaded file is not a supported video format", 400);
  }

  if (fileEntry.type && fileEntry.type !== detectedFileType.mimeType) {
    return error("Uploaded file MIME type does not match file contents", 400);
  }

  const artifactId = generateId();
  const objectKey = buildMediaObjectKey(sessionId, artifactId, detectedFileType.extension);
  const metadata: VideoArtifactMetadata = {
    ...uploadMetadata,
    objectKey,
    mimeType: detectedFileType.mimeType,
    sizeBytes: bytes.byteLength,
  };

  await storage.put(objectKey, bytes, { contentType: detectedFileType.mimeType });

  const persistError = await persistMediaArtifact({
    sessionId,
    artifactId,
    artifactType: "video",
    objectKey,
    metadata,
    storage,
    ctx,
    parseFallback: "Failed to persist video artifact",
  });
  if (persistError) return persistError;

  return json({ artifactId, objectKey }, 201);
}

export const sessionMediaUploadRoutes: Route[] = [
  sessionRoute({
    method: "POST",
    pattern: parsePattern("/sessions/:id/media"),
    handler: handleMediaUpload,
  }),
];
