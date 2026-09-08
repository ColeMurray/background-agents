export type ObjectStoragePutValue = ArrayBuffer | ArrayBufferView | ReadableStream | string;

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
