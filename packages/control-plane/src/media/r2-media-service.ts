/**
 * R2 media storage service.
 *
 * Handles upload, download, and URL generation for media objects
 * (screenshots, file attachments) stored in Cloudflare R2.
 */

export class R2MediaService {
  constructor(private bucket: R2Bucket) {}

  async upload(
    key: string,
    body: ArrayBuffer | ReadableStream,
    contentType: string
  ): Promise<string> {
    await this.bucket.put(key, body, {
      httpMetadata: { contentType },
    });
    return key;
  }

  async get(key: string): Promise<{ body: ReadableStream; contentType: string } | null> {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      body: object.body,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
    };
  }

  async head(key: string): Promise<boolean> {
    const object = await this.bucket.head(key);
    return object !== null;
  }
}
