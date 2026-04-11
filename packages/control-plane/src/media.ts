export const SCREENSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const SCREENSHOT_UPLOAD_LIMIT_PER_SESSION = 100;
export const MEDIA_PRESIGN_TTL_SECONDS = 15 * 60;

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

export function buildR2ObjectUrl(accountId: string, bucketName: string, objectKey: string): URL {
  const encodedPath = objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${encodedPath}`);
}

export async function createPresignedR2GetUrl(args: {
  accountId: string;
  bucketName: string;
  objectKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresInSeconds?: number;
  now?: Date;
}): Promise<{ url: string; expiresAt: number }> {
  const now = args.now ?? new Date();
  const expiresInSeconds = args.expiresInSeconds ?? MEDIA_PRESIGN_TTL_SECONDS;
  const host = `${args.accountId}.r2.cloudflarestorage.com`;
  const url = buildR2ObjectUrl(args.accountId, args.bucketName, args.objectKey);
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;

  const queryEntries: Array<[string, string]> = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${args.accessKeyId}/${credentialScope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresInSeconds)],
    ["X-Amz-SignedHeaders", "host"],
  ];

  const canonicalQueryString = buildCanonicalQueryString(queryEntries);
  const canonicalRequest = [
    "GET",
    url.pathname,
    canonicalQueryString,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await deriveAwsV4SigningKey(args.secretAccessKey, dateStamp, "auto", "s3");
  const signature = await hmacHex(signingKey, stringToSign);

  const signedQueryString = buildCanonicalQueryString([
    ...queryEntries,
    ["X-Amz-Signature", signature],
  ]);

  url.search = signedQueryString;

  return {
    url: url.toString(),
    expiresAt: Math.floor(now.getTime() / 1000) + expiresInSeconds,
  };
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
  const normalized = String(value).trim().toLowerCase();
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
    parsed = JSON.parse(String(value));
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

function formatAmzDate(value: Date): string {
  return value.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function buildCanonicalQueryString(entries: Array<[string, string]>): string {
  return [...entries]
    .sort(([aKey, aValue], [bKey, bValue]) => {
      if (aKey === bKey) {
        return aValue.localeCompare(bValue);
      }
      return aKey.localeCompare(bKey);
    })
    .map(([key, value]) => `${awsPercentEncode(key)}=${awsPercentEncode(value)}`)
    .join("&");
}

function awsPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function deriveAwsV4SigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string
): Promise<CryptoKey> {
  const kDate = await hmacBytes(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacBytes(kDate, region);
  const kService = await hmacBytes(kRegion, service);
  const kSigning = await hmacBytes(kService, "aws4_request");

  return crypto.subtle.importKey("raw", kSigning, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

async function hmacBytes(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const keyBytes = typeof key === "string" ? new TextEncoder().encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(value));
  return new Uint8Array(signature);
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
