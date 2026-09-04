/**
 * The `ObjectStorage` port on S3-compatible storage: AWS S3, MinIO in the
 * compose stack, or any service speaking the S3 API. The Node host's media
 * artifacts (screenshots, uploads, session media) go through it, as they go
 * through R2 on Cloudflare.
 *
 * This is the one module that imports `@aws-sdk/*`. The contract mirrors
 * `R2ObjectStorage`: a missing key is `null` from `head` and `get`, never an
 * error; `size` is the whole object's size even for a ranged read; and
 * `writeHttpMetadata` writes the HTTP metadata stored with the object
 * (content type, language, disposition, encoding, cache control, expiry),
 * not the entity headers the response builder sets itself.
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
import type { ObjectStorage, ObjectStorageMetadata } from "../storage/object-storage";

export interface S3ObjectStorageConfig {
  bucket: string;
  region: string;
  /** Set for MinIO or another non-AWS endpoint; AWS S3 when omitted. */
  endpoint?: string;
  /** `https://host/bucket/key` rather than `https://bucket.host/key`; MinIO needs it. */
  forcePathStyle?: boolean;
  /** Static credentials; the SDK's default provider chain (instance role, env) when omitted. */
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/**
 * The configuration from the `OBJECT_STORE_*` variables. `OBJECT_STORE_BUCKET`
 * is required; `OBJECT_STORE_REGION` defaults to `us-east-1`, the region
 * MinIO and most S3-compatible services answer to.
 */
export function readS3ObjectStorageConfig(
  env: Record<string, string | undefined>
): S3ObjectStorageConfig {
  const bucket = env.OBJECT_STORE_BUCKET;
  if (!bucket) {
    throw new Error("OBJECT_STORE_BUCKET is required to use S3 object storage");
  }
  return {
    bucket,
    region: env.OBJECT_STORE_REGION || "us-east-1",
    endpoint: env.OBJECT_STORE_ENDPOINT || undefined,
    forcePathStyle: env.OBJECT_STORE_FORCE_PATH_STYLE === "true",
  };
}

type PutValue = Parameters<ObjectStorage["put"]>[1];
type PutOptions = Parameters<ObjectStorage["put"]>[2];
type GetOptions = Parameters<ObjectStorage["get"]>[1];
type StoredObject = NonNullable<Awaited<ReturnType<ObjectStorage["get"]>>>;

class S3ObjectStorage implements ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3ObjectStorageConfig) {
    this.bucket = config.bucket;
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
        Body: await bodyBytes(value),
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
      if (isMissingObject(error)) return null;
      throw error;
    }
    return metadataOf(output, output.ContentLength ?? 0);
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
      if (isMissingObject(error)) return null;
      throw error;
    }
    if (!output.Body) return null;
    return {
      ...metadataOf(output, totalSize(output)),
      body: output.Body.transformToWebStream(),
    };
  }
}

export function createS3ObjectStorage(config: S3ObjectStorageConfig): ObjectStorage {
  return new S3ObjectStorage(config);
}

/** The object's whole size: from `Content-Range` on a ranged read, else the body length. */
function totalSize(output: GetObjectCommandOutput): number {
  const match = /\/(\d+)$/.exec(output.ContentRange ?? "");
  if (match) return Number(match[1]);
  return output.ContentLength ?? 0;
}

function metadataOf(
  output: HeadObjectCommandOutput | GetObjectCommandOutput,
  size: number
): ObjectStorageMetadata {
  const httpEtag = output.ETag ?? "";
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

/**
 * Whether the error is S3 saying the key is absent: `NoSuchKey` from
 * GetObject, and the bare 404 (`NotFound`) HeadObject answers with.
 */
function isMissingObject(error: unknown): boolean {
  const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    failure.name === "NoSuchKey" ||
    failure.name === "NotFound" ||
    failure.$metadata?.httpStatusCode === 404
  );
}

/**
 * The value as bytes. A stream is read to the end first: S3 needs the
 * content length up front, and every caller today hands over bytes.
 */
async function bodyBytes(value: PutValue): Promise<Uint8Array | string> {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(await new Response(value).arrayBuffer());
}
