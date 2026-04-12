export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_UPLOAD_LIMIT_PER_SESSION = 100;

const SCREENSHOT_EXTENSIONS = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;

export type SupportedScreenshotMimeType = keyof typeof SCREENSHOT_EXTENSIONS;

export interface ScreenshotFileType {
  mimeType: SupportedScreenshotMimeType;
  extension: (typeof SCREENSHOT_EXTENSIONS)[SupportedScreenshotMimeType];
}

export interface MultipartFileLike {
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type MultipartFieldValue = string | MultipartFileLike;

export function isSupportedScreenshotMimeType(value: string): value is SupportedScreenshotMimeType {
  return value in SCREENSHOT_EXTENSIONS;
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

function hasPrefix(bytes: Uint8Array, prefix: number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}
