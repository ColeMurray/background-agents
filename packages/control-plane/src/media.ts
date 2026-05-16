import type { VideoArtifactMetadata } from "@open-inspect/shared";

export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_UPLOAD_LIMIT_PER_SESSION = 100;
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const VIDEO_UPLOAD_LIMIT_PER_SESSION = 20;
export const VIDEO_MAX_DURATION_MS = 90_000;
export const VIDEO_TIMESTAMP_TOLERANCE_MS = 1_000;

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

export function parseOptionalViewport(
  value: MultipartFieldValue | null
): { width: number; height: number } | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error("viewport must be a JSON string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("viewport must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("viewport must be an object");
  }

  const candidate = parsed as { width?: unknown; height?: unknown };
  if (
    typeof candidate.width !== "number" ||
    !Number.isFinite(candidate.width) ||
    candidate.width <= 0 ||
    typeof candidate.height !== "number" ||
    !Number.isFinite(candidate.height) ||
    candidate.height <= 0
  ) {
    throw new Error("viewport must include positive width and height");
  }

  return {
    width: Math.round(candidate.width),
    height: Math.round(candidate.height),
  };
}

export function parseVideoUploadMetadata(
  fields: MultipartFieldsLike,
  createdAt = Date.now()
): VideoUploadMetadata {
  const caption = parseRequiredString(fields.get("caption"), "caption");
  const durationMs = parseRequiredPositiveInteger(fields.get("durationMs"), "durationMs");
  if (durationMs > VIDEO_MAX_DURATION_MS) {
    throw new Error(`durationMs must be ${VIDEO_MAX_DURATION_MS} or less`);
  }

  const recordingStartedAt = parseRequiredPositiveInteger(
    fields.get("recordingStartedAt"),
    "recordingStartedAt"
  );
  const recordingEndedAt = parseRequiredPositiveInteger(
    fields.get("recordingEndedAt"),
    "recordingEndedAt"
  );
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

  const dimensions = parseRequiredDimensions(fields.get("dimensions"));
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

function parseRequiredPositiveInteger(value: MultipartFieldValue | null, name: string): number {
  const stringValue = parseRequiredString(value, name);
  if (stringValue === "0") {
    throw new Error(`${name} must be a positive number`);
  }
  if (!/^[1-9]\d*$/.test(stringValue)) {
    throw new Error(`${name} must be a positive integer`);
  }

  return Number(stringValue);
}

function parseRequiredBoolean(value: MultipartFieldValue | null, name: string): boolean {
  if (value === null) {
    throw new Error(`${name} is required`);
  }

  return parseOptionalBoolean(value) ?? false;
}

function parseRequiredDimensions(value: MultipartFieldValue | null): {
  width: number;
  height: number;
} {
  if (value === null) {
    throw new Error("dimensions is required");
  }

  if (typeof value !== "string") {
    throw new Error("dimensions must be a JSON string");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("dimensions must be valid JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("dimensions must be an object");
  }

  const candidate = parsed as { width?: unknown; height?: unknown };
  if (
    typeof candidate.width !== "number" ||
    !Number.isFinite(candidate.width) ||
    !Number.isInteger(candidate.width) ||
    candidate.width <= 0 ||
    typeof candidate.height !== "number" ||
    !Number.isFinite(candidate.height) ||
    !Number.isInteger(candidate.height) ||
    candidate.height <= 0
  ) {
    throw new Error("dimensions must include positive integer width and height");
  }

  return {
    width: candidate.width,
    height: candidate.height,
  };
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
