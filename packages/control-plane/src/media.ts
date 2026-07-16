import {
  PROMPT_IMAGE_MIME_TYPES,
  type PromptImageMimeType,
  type VideoArtifactMetadata,
} from "@open-inspect/shared";

export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_UPLOAD_LIMIT_PER_SESSION = 100;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_UPLOAD_LIMIT_PER_SESSION = 20;
export const VIDEO_MAX_DURATION_MS = 90_000;
export const VIDEO_TIMESTAMP_TOLERANCE_MS = 1_000;

// User-attached prompt images (attached in the chat composer).
export const PROMPT_UPLOAD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
// Allows multipart boundaries and headers while rejecting oversized requests
// before request.formData() buffers them when Content-Length is available.
export const PROMPT_UPLOAD_MAX_REQUEST_BYTES = PROMPT_UPLOAD_IMAGE_MAX_BYTES + 128 * 1024;
export const PROMPT_UPLOAD_LIMIT_PER_SESSION = 100;
export const PROMPT_UPLOAD_TOTAL_BYTES_PER_SESSION = 500 * 1024 * 1024;
// Uploads never referenced by a prompt after this long are pruned (R2 object +
// record) the next time the session records an upload.
export const PROMPT_UPLOAD_UNREFERENCED_TTL_MS = 24 * 60 * 60 * 1000;
export const PROMPT_UPLOAD_CLEANUP_CLAIM_TTL_MS = 5 * 60 * 1000;

const SCREENSHOT_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

const VIDEO_EXTENSIONS = {
  "video/mp4": "mp4",
} as const;

export type SupportedScreenshotMimeType = keyof typeof SCREENSHOT_EXTENSIONS;
export type SupportedVideoMimeType = keyof typeof VIDEO_EXTENSIONS;

export interface ScreenshotFileType {
  mimeType: SupportedScreenshotMimeType;
  extension: (typeof SCREENSHOT_EXTENSIONS)[SupportedScreenshotMimeType];
}

export interface VideoFileType {
  mimeType: SupportedVideoMimeType;
  extension: (typeof VIDEO_EXTENSIONS)[SupportedVideoMimeType];
}

export interface MultipartFileLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MultipartFieldValue = string | MultipartFileLike;
export type VideoUploadMetadata = Omit<
  VideoArtifactMetadata,
  "objectKey" | "mimeType" | "sizeBytes"
>;

export interface MultipartFieldsLike {
  get(name: string): MultipartFieldValue | null;
}

export function isSupportedScreenshotMimeType(value: string): value is SupportedScreenshotMimeType {
  return value in SCREENSHOT_EXTENSIONS;
}

export function isSupportedVideoMimeType(value: string): value is SupportedVideoMimeType {
  return value in VIDEO_EXTENSIONS;
}

export function detectScreenshotFileType(bytes: Uint8Array): ScreenshotFileType | null {
  if (bytes.length >= 8 && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mimeType: "image/png", extension: "png" };
  }

  if (bytes.length >= 3 && hasPrefix(bytes, [0xff, 0xd8, 0xff])) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }

  if (
    bytes.length >= 12 &&
    hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    hasPrefix(bytes.slice(8, 12), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { mimeType: "image/webp", extension: "webp" };
  }

  return null;
}

export function detectVideoFileType(bytes: Uint8Array): VideoFileType | null {
  if (
    bytes.length >= 12 &&
    hasPrefix(bytes.slice(4, 8), [0x66, 0x74, 0x79, 0x70]) &&
    isMp4CompatibleBrand(bytes.slice(8, 12))
  ) {
    return { mimeType: "video/mp4", extension: "mp4" };
  }

  return null;
}

export type PromptUploadFileType = {
  mimeType: PromptImageMimeType;
  extension: string;
};

const PROMPT_UPLOAD_MIME_TYPES: ReadonlySet<string> = new Set(PROMPT_IMAGE_MIME_TYPES);

export function isSupportedPromptUploadMimeType(value: string): value is PromptImageMimeType {
  return PROMPT_UPLOAD_MIME_TYPES.has(value);
}

export function promptUploadRequestExceedsLimit(request: Request): boolean {
  const raw = request.headers.get("Content-Length");
  if (!raw || !/^\d+$/.test(raw)) return false;
  return Number(raw) > PROMPT_UPLOAD_MAX_REQUEST_BYTES;
}

/**
 * Detect user-attached prompt images by magic bytes. This is intentionally
 * separate from the agent screenshot/recording detectors: prompt uploads do
 * not support videos in the initial attachment release.
 */
export function detectPromptUploadFileType(bytes: Uint8Array): PromptUploadFileType | null {
  const image = detectScreenshotFileType(bytes);
  if (image) {
    return { mimeType: image.mimeType, extension: image.extension };
  }

  // GIF87a / GIF89a
  if (
    bytes.length >= 6 &&
    hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38]) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return { mimeType: "image/gif", extension: "gif" };
  }

  return null;
}

export function buildPromptUploadObjectKey(sessionId: string, uploadId: string): string {
  return `sessions/${sessionId}/uploads/${uploadId}`;
}

export function buildMediaObjectKey(
  sessionId: string,
  artifactId: string,
  extension: string
): string {
  return `sessions/${sessionId}/media/${artifactId}.${extension}`;
}

export function isMultipartFile(value: MultipartFieldValue | null): value is MultipartFileLike {
  return (
    value !== null &&
    typeof value !== "string" &&
    typeof value.arrayBuffer === "function" &&
    typeof value.size === "number" &&
    typeof value.type === "string"
  );
}

export function parseOptionalBoolean(value: MultipartFieldValue | null): boolean | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("Boolean fields must be strings");
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new Error("Boolean fields must be 'true' or 'false'");
}

type Dimensions = { width: number; height: number };
type DimensionsMode = "integer" | "round";

export function parseDimensions(
  value: MultipartFieldValue | null,
  opts: { name: string; required: true; mode: DimensionsMode }
): Dimensions;
export function parseDimensions(
  value: MultipartFieldValue | null,
  opts: { name: string; required: false; mode: DimensionsMode }
): Dimensions | undefined;
export function parseDimensions(
  value: MultipartFieldValue | null,
  opts: { name: string; required: boolean; mode: DimensionsMode }
): Dimensions | undefined {
  if (value === null) {
    if (opts.required) throw new Error(`${opts.name} is required`);
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${opts.name} must be a JSON string`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${opts.name} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${opts.name} must be an object`);
  }

  const candidate = parsed as { width?: unknown; height?: unknown };
  const width = coerceDimension(candidate.width, opts.mode);
  const height = coerceDimension(candidate.height, opts.mode);
  if (width === null || height === null) {
    const detail =
      opts.mode === "integer" ? "positive integer width and height" : "positive width and height";
    throw new Error(`${opts.name} must include ${detail}`);
  }

  return { width, height };
}

function coerceDimension(value: unknown, mode: DimensionsMode): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (mode === "integer") return Number.isInteger(value) ? value : null;
  // Reject values that round to 0 — Math.round(0.4) === 0 would silently produce a zero dimension.
  const rounded = Math.round(value);
  return rounded > 0 ? rounded : null;
}

export function parseVideoUploadMetadata(
  fields: MultipartFieldsLike,
  createdAt = Date.now()
): VideoUploadMetadata {
  const caption = parseRequiredString(fields.get("caption"), "caption");
  const durationMs = parsePositiveInteger(fields.get("durationMs"), {
    name: "durationMs",
    max: VIDEO_MAX_DURATION_MS,
  });
  const recordingStartedAt = parsePositiveInteger(fields.get("recordingStartedAt"), {
    name: "recordingStartedAt",
  });
  const recordingEndedAt = parsePositiveInteger(fields.get("recordingEndedAt"), {
    name: "recordingEndedAt",
  });
  if (recordingEndedAt < recordingStartedAt) {
    throw new Error("recordingEndedAt must be greater than or equal to recordingStartedAt");
  }
  const elapsedMs = recordingEndedAt - recordingStartedAt;
  if (elapsedMs > VIDEO_MAX_DURATION_MS + VIDEO_TIMESTAMP_TOLERANCE_MS) {
    throw new Error(`recording timestamps must span ${VIDEO_MAX_DURATION_MS}ms or less`);
  }
  if (durationMs > elapsedMs + VIDEO_TIMESTAMP_TOLERANCE_MS) {
    throw new Error("durationMs must not exceed the recording timestamp span");
  }

  const dimensions = parseDimensions(fields.get("dimensions"), {
    name: "dimensions",
    required: true,
    mode: "integer",
  });
  const truncated = parseRequiredBoolean(fields.get("truncated"), "truncated");
  const sourceUrl = parseOptionalUrl(fields.get("sourceUrl"), "sourceUrl");
  const endUrl = parseOptionalUrl(fields.get("endUrl"), "endUrl");
  const hasAudio = parseOptionalBoolean(fields.get("hasAudio"));
  if (hasAudio === true) {
    throw new Error("hasAudio must be false");
  }

  return {
    caption,
    durationMs,
    createdAt,
    recordingStartedAt,
    recordingEndedAt,
    dimensions,
    truncated,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(endUrl ? { endUrl } : {}),
    ...(hasAudio === false ? { hasAudio: false } : {}),
    captureSurface: "browser",
    source: "agent",
  };
}

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function isMp4CompatibleBrand(brand: Uint8Array): boolean {
  if (brand.length < 4) return false;
  const value = String.fromCharCode(...brand);
  return (
    value === "isom" ||
    value === "iso2" ||
    value === "mp41" ||
    value === "mp42" ||
    value === "avc1" ||
    value === "M4V "
  );
}

function parseRequiredString(value: MultipartFieldValue | null, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value.trim();
}

// Strict integer-only parsing — rejects decimals, exponents, and unsafe sizes.
function parsePositiveInteger(
  value: MultipartFieldValue | null,
  opts: { name: string; max?: number }
): number {
  const text = parseRequiredString(value, opts.name);
  if (!/^[1-9]\d*$/.test(text)) {
    throw new Error(`${opts.name} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${opts.name} must be a safe integer`);
  }
  if (opts.max !== undefined && parsed > opts.max) {
    throw new Error(`${opts.name} must be ${opts.max} or less`);
  }
  return parsed;
}

function parseRequiredBoolean(value: MultipartFieldValue | null, name: string): boolean {
  const parsed = parseOptionalBoolean(value);
  if (parsed === undefined) {
    throw new Error(`${name} is required`);
  }
  return parsed;
}

function parseOptionalUrl(value: MultipartFieldValue | null, name: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    new URL(trimmed);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  return trimmed;
}
