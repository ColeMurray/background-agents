import type { Env } from "../types";

type ObjectStoragePutValue = ArrayBuffer | ArrayBufferView | ReadableStream | string;

export type ObjectStoragePutOptions = {
  contentType?: string;
};

export type ObjectStorageRange = {
  offset: number;
  length: number;
};

export type ObjectStorageMetadata = {
  size: number;
  httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
};

export type ObjectStorageObject = ObjectStorageMetadata & {
  body: ReadableStream;
};

export interface ObjectStorage {
  put(key: string, value: ObjectStoragePutValue, options?: ObjectStoragePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<ObjectStorageMetadata | null>;
  get(key: string, options?: { range?: ObjectStorageRange }): Promise<ObjectStorageObject | null>;
}

class R2ObjectStorage implements ObjectStorage {
  constructor(private readonly bucket: R2Bucket) {}

  async put(
    key: string,
    value: ObjectStoragePutValue,
    options?: ObjectStoragePutOptions
  ): Promise<void> {
    await this.bucket.put(
      key,
      value,
      options?.contentType ? { httpMetadata: { contentType: options.contentType } } : undefined
    );
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async head(key: string): Promise<ObjectStorageMetadata | null> {
    return this.bucket.head(key);
  }

  async get(
    key: string,
    options?: { range?: ObjectStorageRange }
  ): Promise<ObjectStorageObject | null> {
    return this.bucket.get(key, options?.range ? { range: options.range } : undefined);
  }
}

export function createMediaObjectStorage(env: Env): ObjectStorage {
  return createObjectStorage(env.MEDIA_BUCKET);
}

export function createObjectStorage(bucket: R2Bucket): ObjectStorage {
  return new R2ObjectStorage(bucket);
}
