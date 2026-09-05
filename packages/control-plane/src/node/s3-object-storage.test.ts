import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ObjectStorage } from "../storage/object-storage";
import { createS3ObjectStorage, readS3ObjectStorageConfig } from "./s3-object-storage";

const BUCKET = "media-bucket";

interface StoredObject {
  bytes: Buffer;
  contentType: string | undefined;
}

/**
 * The slice of the S3 REST API the four port methods use, path-style, with
 * S3's answers: quoted MD5 ETags, `NoSuchKey` XML on a missing GET, a bare
 * 404 on a missing HEAD, 206 with `Content-Range` for a ranged GET, 204 on
 * DELETE whether or not the key existed.
 */
class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly requests: Array<{
    method: string;
    path: string;
    range: string | undefined;
    securityToken: string | undefined;
  }> = [];
  /** A provider that answers without ETags, which the S3 API always carries. */
  omitEtag = false;
  private server: Server | null = null;
  endpoint = "";

  async start(): Promise<void> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url!, this.endpoint);
    const key = decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, ""));
    this.requests.push({
      method: request.method!,
      path: url.pathname,
      range: request.headers.range,
      securityToken: request.headers["x-amz-security-token"] as string | undefined,
    });
    if (!url.pathname.startsWith(`/${BUCKET}/`)) {
      // A missing bucket: S3 names it in the body, except on HEAD, which has none.
      if (request.method === "HEAD") {
        response.writeHead(404).end();
      } else {
        response
          .writeHead(404, { "Content-Type": "application/xml" })
          .end(`<?xml version="1.0"?><Error><Code>NoSuchBucket</Code></Error>`);
      }
      return;
    }
    switch (request.method) {
      case "PUT": {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const bytes = Buffer.concat(chunks);
          this.objects.set(key, { bytes, contentType: request.headers["content-type"] });
          response.writeHead(200, { ETag: etagOf(bytes) }).end();
        });
        return;
      }
      case "DELETE": {
        this.objects.delete(key);
        response.writeHead(204).end();
        return;
      }
      case "HEAD": {
        const object = this.objects.get(key);
        if (!object) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, headersOf(object, this.omitEtag)).end();
        return;
      }
      case "GET": {
        const object = this.objects.get(key);
        if (!object) {
          response
            .writeHead(404, { "Content-Type": "application/xml" })
            .end(`<?xml version="1.0"?><Error><Code>NoSuchKey</Code><Key>${key}</Key></Error>`);
          return;
        }
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
        if (range) {
          const start = Number(range[1]);
          const end = Math.min(Number(range[2]), object.bytes.length - 1);
          const part = object.bytes.subarray(start, end + 1);
          response
            .writeHead(206, {
              ...headersOf(object),
              "Content-Length": String(part.length),
              "Content-Range": `bytes ${start}-${end}/${object.bytes.length}`,
            })
            .end(part);
          return;
        }
        response.writeHead(200, headersOf(object)).end(object.bytes);
        return;
      }
      default:
        response.writeHead(405).end();
    }
  }
}

function etagOf(bytes: Buffer): string {
  return `"${createHash("md5").update(bytes).digest("hex")}"`;
}

function headersOf(object: StoredObject, omitEtag = false): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Length": String(object.bytes.length),
    "Last-Modified": new Date(0).toUTCString(),
  };
  if (!omitEtag) headers.ETag = etagOf(object.bytes);
  if (object.contentType) headers["Content-Type"] = object.contentType;
  return headers;
}

async function readAll(stream: ReadableStream): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

describe("createS3ObjectStorage", () => {
  const s3 = new FakeS3();
  let storage: ObjectStorage;

  beforeAll(async () => {
    await s3.start();
    storage = createS3ObjectStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint: s3.endpoint,
      allowHttpEndpoint: true,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
  });

  afterAll(async () => {
    await s3.stop();
  });

  beforeEach(() => {
    s3.objects.clear();
    s3.requests.length = 0;
    s3.omitEtag = false;
  });

  it("puts bytes with their content type, path-style, and reads them back whole", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    await storage.put("sessions/s1/shot.png", bytes, { contentType: "image/png" });

    expect(s3.requests[0]).toMatchObject({
      method: "PUT",
      path: `/${BUCKET}/sessions/s1/shot.png`,
    });
    expect(s3.objects.get("sessions/s1/shot.png")).toEqual({
      bytes: Buffer.from(bytes),
      contentType: "image/png",
    });

    const object = await storage.get("sessions/s1/shot.png");
    expect(object).not.toBeNull();
    expect(object!.size).toBe(4);
    expect(object!.httpEtag).toBe(etagOf(Buffer.from(bytes)));
    expect(await readAll(object!.body)).toEqual(Buffer.from(bytes));
    const headers = new Headers();
    object!.writeHttpMetadata(headers);
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(headers.get("ETag")).toBeNull();
    expect(headers.get("Content-Length")).toBeNull();
  });

  it("puts a string, an ArrayBuffer, a view, and a stream as their bytes", async () => {
    const text = new TextEncoder().encode("hello");
    const buffer = new ArrayBuffer(text.length);
    new Uint8Array(buffer).set(text);
    await storage.put("k/string", "hello");
    await storage.put("k/buffer", buffer);
    await storage.put("k/view", new Uint8Array(buffer, 1, 3));
    await storage.put(
      "k/stream",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.subarray(0, 2));
          controller.enqueue(text.subarray(2));
          controller.close();
        },
      })
    );

    expect(s3.objects.get("k/string")!.bytes.toString()).toBe("hello");
    expect(s3.objects.get("k/buffer")!.bytes.toString()).toBe("hello");
    expect(s3.objects.get("k/view")!.bytes.toString()).toBe("ell");
    expect(s3.objects.get("k/stream")!.bytes.toString()).toBe("hello");
  });

  it("maps HEAD to the metadata shape, writing only the stored HTTP metadata", async () => {
    await storage.put("k/doc", new Uint8Array(10), { contentType: "video/mp4" });

    const head = await storage.head("k/doc");
    expect(head).not.toBeNull();
    expect(head!.size).toBe(10);
    expect(head!.httpEtag).toBe(etagOf(Buffer.alloc(10)));
    const headers = new Headers();
    head!.writeHttpMetadata(headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(headers.get("Content-Type")).toBe("video/mp4");
  });

  it("answers null, not an error, for a missing key on head and get", async () => {
    expect(await storage.head("k/absent")).toBeNull();
    expect(await storage.get("k/absent")).toBeNull();
    expect(await storage.get("k/absent", { range: { offset: 0, length: 1 } })).toBeNull();
  });

  it("reads a byte range, reporting the whole object's size as R2 does", async () => {
    const bytes = Buffer.from("0123456789abcdef");
    await storage.put("k/ranged", bytes);

    const part = await storage.get("k/ranged", { range: { offset: 4, length: 6 } });
    expect(part).not.toBeNull();
    expect(s3.requests.at(-1)).toMatchObject({ method: "GET", range: "bytes=4-9" });
    expect((await readAll(part!.body)).toString()).toBe("456789");
    expect(part!.size).toBe(16);
  });

  it("reports a missing bucket as an error, not as a missing key", async () => {
    const elsewhere = createS3ObjectStorage({
      bucket: "no-such-bucket",
      region: "us-east-1",
      endpoint: s3.endpoint,
      allowHttpEndpoint: true,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });

    await expect(elsewhere.get("k/doc")).rejects.toMatchObject({ name: "NoSuchBucket" });
    await expect(elsewhere.put("k/doc", "x")).rejects.toMatchObject({ name: "NoSuchBucket" });
    await expect(elsewhere.delete("k/doc")).rejects.toMatchObject({ name: "NoSuchBucket" });
    // HEAD carries no body, so S3 cannot say which is missing; the port's
    // answer for an unreachable object is null, the same as R2's.
    expect(await elsewhere.head("k/doc")).toBeNull();
  });

  it("reports a provider answering without the fields the port promises", async () => {
    await storage.put("k/doc", new Uint8Array(3));
    s3.omitEtag = true;

    await expect(storage.head("k/doc")).rejects.toThrow(
      "S3 HeadObject/GetObject for k/doc answered without ETag"
    );
  });

  it("sends a temporary credential's session token with every request", async () => {
    const temporary = createS3ObjectStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint: s3.endpoint,
      allowHttpEndpoint: true,
      forcePathStyle: true,
      credentials: { accessKeyId: "ASIA", secretAccessKey: "secret", sessionToken: "sts-token" },
    });

    await temporary.put("k/doc", "x");
    expect(await temporary.head("k/doc")).not.toBeNull();

    expect(s3.requests.map((request) => request.securityToken)).toEqual(["sts-token", "sts-token"]);
  });

  it("refuses a plaintext endpoint unless a local stack opts in", () => {
    expect(() =>
      createS3ObjectStorage({ bucket: BUCKET, region: "us-east-1", endpoint: s3.endpoint })
    ).toThrow("plaintext http");
    expect(() =>
      createS3ObjectStorage({ bucket: BUCKET, region: "us-east-1", endpoint: "https://s3.example" })
    ).not.toThrow();
  });

  it("refuses an object past the size limit, cancelling a stream as soon as it is exceeded", async () => {
    const bounded = createS3ObjectStorage({
      bucket: BUCKET,
      region: "us-east-1",
      endpoint: s3.endpoint,
      allowHttpEndpoint: true,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxObjectBytes: 8,
    });
    let pulls = 0;
    let cancelled = false;
    // Never closes: without the limit, put would buffer it forever.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(4));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(bounded.put("k/endless", endless)).rejects.toThrow(RangeError);
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(8);
    await expect(bounded.put("k/big", new Uint8Array(9))).rejects.toThrow("exceeds 8 bytes");
    await expect(bounded.put("k/fits", new Uint8Array(8))).resolves.toBeUndefined();
    expect(s3.requests.map((request) => request.path)).toEqual([`/${BUCKET}/k/fits`]);
  });

  it("deletes a key, and deleting an absent key is not an error", async () => {
    await storage.put("k/gone", new Uint8Array([1]));
    await storage.delete("k/gone");
    expect(s3.objects.has("k/gone")).toBe(false);
    expect(await storage.head("k/gone")).toBeNull();
    await expect(storage.delete("k/gone")).resolves.toBeUndefined();
  });
});

describe("readS3ObjectStorageConfig", () => {
  it("reads the OBJECT_STORE_* variables, defaulting the region", () => {
    expect(
      readS3ObjectStorageConfig({
        OBJECT_STORE_BUCKET: "media",
        OBJECT_STORE_ENDPOINT: "http://minio:9000",
        OBJECT_STORE_FORCE_PATH_STYLE: "true",
      })
    ).toEqual({
      bucket: "media",
      region: "us-east-1",
      endpoint: "http://minio:9000",
      allowHttpEndpoint: false,
      forcePathStyle: true,
    });
    expect(
      readS3ObjectStorageConfig({
        OBJECT_STORE_BUCKET: "media",
        OBJECT_STORE_REGION: "eu-west-1",
        OBJECT_STORE_ALLOW_HTTP: "true",
      })
    ).toEqual({
      bucket: "media",
      region: "eu-west-1",
      endpoint: undefined,
      allowHttpEndpoint: true,
      forcePathStyle: false,
    });
  });

  it("requires the bucket", () => {
    expect(() => readS3ObjectStorageConfig({})).toThrow("OBJECT_STORE_BUCKET is required");
  });
});
