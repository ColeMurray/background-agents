import type {
  ObjectStorage,
  ObjectStorageMetadata,
  ObjectStorageObject,
  ObjectStoragePutOptions,
  ObjectStoragePutValue,
  ObjectStorageRange,
} from "../storage/object-storage";

/** The media store on an R2 bucket. */
export class R2ObjectStorage implements ObjectStorage {
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
