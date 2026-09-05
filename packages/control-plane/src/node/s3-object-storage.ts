/**
 * The `ObjectStorage` port on S3-compatible storage: AWS S3, MinIO in the
 * compose stack, or any service speaking the S3 API. The Node host's media
 * artifacts (screenshots, uploads, session media) go through it, as they go
 * through R2 on Cloudflare.
 *
 * This is the one module that imports `@aws-sdk/*`. The contract mirrors
 * `R2ObjectStorage`: a missing key is `null` from `head` and `get`, and only
 * a missing key; a missing bucket, a wrong endpoint, or a response without
 * the fields the port promises is an error, so a deployment fault never
 * reads as an absent artifact. `size` is the whole object's size even for a
 * ranged read, and `writeHttpMetadata` writes the HTTP metadata stored with
 * the object (content type, language, disposition, encoding, cache control,
 * expiry), not the entity headers the response builder sets itself.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
  type HeadObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { VIDEO_MAX_BYTES } from "../media";
import { pickVariables, type ConfigSource } from "./config";
import type { ObjectStorage, ObjectStorageMetadata } from "../storage/object-storage";

export interface S3ObjectStorageConfig {
  bucket: string;
  region: string;
  /** Set for MinIO or another non-AWS endpoint; AWS S3 when omitted. */
  endpoint?: string;
  /**
   * Whether a plaintext `http:` endpoint is accepted. Signed requests and
   * object data would cross the network in the clear, so only a local
   * compose stack should set it; an `http:` endpoint is otherwise refused.
   */
  allowHttpEndpoint?: boolean;
  /** `https://host/bucket/key` rather than `https://bucket.host/key`; MinIO needs it. */
  forcePathStyle?: boolean;
  /**
   * Static credentials, with the session token of temporary (STS) ones;
   * the SDK's default provider chain (instance role, env) when omitted.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /**
   * The largest object `put` accepts, so a stream cannot be buffered
   * without bound. Defaults to the largest media object a route stores.
   */
  maxObjectBytes?: number;
}

/** The object-store variables; `readS3ObjectStorageConfig` reads through this table only. */
export const OBJECT_STORAGE_VARIABLE_NAMES = [
  "OBJECT_STORE_BUCKET",
  "OBJECT_STORE_REGION",
  "OBJECT_STORE_ENDPOINT",
  "OBJECT_STORE_ALLOW_HTTP",
  "OBJECT_STORE_FORCE_PATH_STYLE",
] as const;

/**
 * The static-credential variables of the SDK's default provider chain that
 * a deployment may set. The chain's other sources (an instance role, a
 * shared credentials file) take nothing from the environment we document.
 */
export const AWS_CREDENTIAL_VARIABLE_NAMES = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;

/** The region MinIO and most S3-compatible services answer to. */
const DEFAULT_OBJECT_STORE_REGION = "us-east-1";

/**
 * The configuration from the `OBJECT_STORE_*` variables. `OBJECT_STORE_BUCKET`
 * is required; `OBJECT_STORE_REGION` defaults to DEFAULT_OBJECT_STORE_REGION;
 * `OBJECT_STORE_ALLOW_HTTP` is the opt-in for a plaintext endpoint.
 */
export function readS3ObjectStorageConfig(env: ConfigSource): S3ObjectStorageConfig {
  const variables = pickVariables(env, OBJECT_STORAGE_VARIABLE_NAMES);
  const bucket = variables.OBJECT_STORE_BUCKET;
  if (!bucket) {
    throw new Error("OBJECT_STORE_BUCKET is required to use S3 object storage");
  }
  return {
    bucket,
    region: variables.OBJECT_STORE_REGION || DEFAULT_OBJECT_STORE_REGION,
    endpoint: variables.OBJECT_STORE_ENDPOINT || undefined,
    allowHttpEndpoint: variables.OBJECT_STORE_ALLOW_HTTP === "true",
    forcePathStyle: variables.OBJECT_STORE_FORCE_PATH_STYLE === "true",
  };
}

type PutValue = Parameters<ObjectStorage["put"]>[1];
type PutOptions = Parameters<ObjectStorage["put"]>[2];
type GetOptions = Parameters<ObjectStorage["get"]>[1];
type StoredObject = NonNullable<Awaited<ReturnType<ObjectStorage["get"]>>>;

class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly maxObjectBytes: number;

  constructor(config: S3ObjectStorageConfig) {
    if (
      config.endpoint &&
      new URL(config.endpoint).protocol === "http:" &&
      !config.allowHttpEndpoint
    ) {
      throw new Error(
        `S3 endpoint ${config.endpoint} is plaintext http; signed requests and object data ` +
          "would cross the network in the clear. Use https, or set OBJECT_STORE_ALLOW_HTTP=true " +
          "for a local compose stack only."
      );
    }
    this.bucket = config.bucket;
    this.maxObjectBytes = config.maxObjectBytes ?? VIDEO_MAX_BYTES;
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? false,
      credentials: config.credentials,
    });
  }

  async put(key: string, value: PutValue, options?: PutOptions): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: await bodyBytes(value, this.maxObjectBytes),
        ContentType: options?.contentType,
      })
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async head(key: string): Promise<ObjectStorageMetadata | null> {
    let output: HeadObjectCommandOutput;
    try {
      output = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // HeadObject answers a bare 404, which the SDK names NotFound; S3 gives
      // it no body to say whether the key or the bucket is what is missing.
      if (isNamed(error, "NotFound")) return null;
      throw error;
    }
    return metadataOf(
      output,
      required(output.ContentLength, "ContentLength", "HeadObject", key),
      key
    );
  }

  async get(key: string, options?: GetOptions): Promise<StoredObject | null> {
    const range = options?.range;
    let output: GetObjectCommandOutput;
    try {
      output = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined,
        })
      );
    } catch (error) {
      if (isNamed(error, "NoSuchKey")) return null;
      throw error;
    }
    const body = required(output.Body, "Body", "GetObject", key);
    return {
      ...metadataOf(output, totalSize(output, range !== undefined, key), key),
      body: body.transformToWebStream(),
    };
  }
}

export function createS3ObjectStorage(config: S3ObjectStorageConfig): ObjectStorage {
  return new S3ObjectStorage(config);
}

/** The object's whole size: from `Content-Range` on a ranged read, else the body length. */
function totalSize(output: GetObjectCommandOutput, ranged: boolean, key: string): number {
  if (!ranged) return required(output.ContentLength, "ContentLength", "GetObject", key);
  const match = /\/(\d+)$/.exec(required(output.ContentRange, "ContentRange", "GetObject", key));
  if (!match) {
    throw new Error(
      `S3 GetObject for ${key} answered a range with Content-Range ${output.ContentRange}, ` +
        "which does not carry the object's size"
    );
  }
  return Number(match[1]);
}

function metadataOf(
  output: HeadObjectCommandOutput | GetObjectCommandOutput,
  size: number,
  key: string
): ObjectStorageMetadata {
  const httpEtag = required(output.ETag, "ETag", "HeadObject/GetObject", key);
  const stored: Array<[string, string | undefined]> = [
    ["Content-Type", output.ContentType],
    ["Content-Language", output.ContentLanguage],
    ["Content-Disposition", output.ContentDisposition],
    ["Content-Encoding", output.ContentEncoding],
    ["Cache-Control", output.CacheControl],
    ["Expires", output.Expires?.toUTCString()],
  ];
  return {
    size,
    httpEtag,
    writeHttpMetadata(headers: Headers): void {
      for (const [name, value] of stored) {
        if (value !== undefined) headers.set(name, value);
      }
    },
  };
}

/** Whether the SDK classified the failure as S3's error `name`. */
function isNamed(error: unknown, name: string): boolean {
  return (error as { name?: string }).name === name;
}

/**
 * The field, which a well-formed S3 response always carries. Its absence
 * is the provider not speaking the S3 API the port is built on, reported
 * as such rather than read as an empty or absent object.
 */
function required<T>(value: T | undefined, field: string, operation: string, key: string): T {
  if (value === undefined) {
    throw new Error(`S3 ${operation} for ${key} answered without ${field}`);
  }
  return value;
}

/**
 * The value as bytes, refused past `maxBytes`. A stream is read to the end
 * first, since S3 needs the content length up front, and is cancelled the
 * moment it exceeds the limit, so no caller can have the host buffer
 * without bound.
 */
async function bodyBytes(value: PutValue, maxBytes: number): Promise<Uint8Array | string> {
  if (typeof value === "string") return withinLimit(new TextEncoder().encode(value), maxBytes);
  if (value instanceof ArrayBuffer) return withinLimit(new Uint8Array(value), maxBytes);
  if (ArrayBuffer.isView(value)) {
    return withinLimit(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = value.getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RangeError(`S3 put refused: the object exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function withinLimit(bytes: Uint8Array, maxBytes: number): Uint8Array {
  if (bytes.byteLength > maxBytes) {
    throw new RangeError(`S3 put refused: the object exceeds ${maxBytes} bytes`);
  }
  return bytes;
}
