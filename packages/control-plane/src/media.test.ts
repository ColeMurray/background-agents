import { describe, expect, it } from "vitest";
import {
  buildMediaObjectKey,
  createPresignedR2GetUrl,
  detectScreenshotFileType,
  parseOptionalBoolean,
  parseOptionalViewport,
} from "./media";

describe("media helpers", () => {
  it("builds session-scoped media object keys", () => {
    expect(buildMediaObjectKey("session-1", "artifact-1", "png")).toBe(
      "sessions/session-1/media/artifact-1.png"
    );
  });

  it.each([
    [
      "PNG",
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      { mimeType: "image/png", extension: "png" },
    ],
    [
      "JPEG",
      Uint8Array.from([0xff, 0xd8, 0xff, 0x00]),
      { mimeType: "image/jpeg", extension: "jpg" },
    ],
    [
      "WEBP",
      Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x01, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
      { mimeType: "image/webp", extension: "webp" },
    ],
    ["unsupported", Uint8Array.from([0x00, 0x01, 0x02]), null],
  ] satisfies [string, Uint8Array, ReturnType<typeof detectScreenshotFileType>][])(
    "detects %s screenshots by magic bytes",
    (_label, bytes, expected) => {
      expect(detectScreenshotFileType(bytes)).toEqual(expected);
    }
  );

  it("parses optional booleans with whitespace and casing", () => {
    expect(parseOptionalBoolean(" TRUE ")).toBe(true);
    expect(parseOptionalBoolean("false")).toBe(false);
    expect(parseOptionalBoolean(null)).toBeUndefined();
  });

  it("rejects invalid optional boolean values", () => {
    expect(() => parseOptionalBoolean("maybe")).toThrow("Boolean fields must be 'true' or 'false'");
    expect(() =>
      parseOptionalBoolean({
        size: 1,
        type: "text/plain",
        arrayBuffer: async () => new ArrayBuffer(0),
      })
    ).toThrow("Boolean fields must be strings");
  });

  it("parses optional viewport JSON and rounds dimensions", () => {
    expect(parseOptionalViewport('{"width":1279.6,"height":719.2}')).toEqual({
      width: 1280,
      height: 719,
    });
    expect(parseOptionalViewport(null)).toBeUndefined();
  });

  it("rejects invalid viewport payloads", () => {
    expect(() => parseOptionalViewport("not-json")).toThrow("viewport must be valid JSON");
    expect(() => parseOptionalViewport("123")).toThrow("viewport must be an object");
    expect(() => parseOptionalViewport('{"width":0,"height":100}')).toThrow(
      "viewport must include positive width and height"
    );
  });

  it("creates deterministic presigned R2 GET URLs", async () => {
    const now = new Date("2026-04-11T12:00:00.000Z");

    const result = await createPresignedR2GetUrl({
      accountId: "account-123",
      bucketName: "media-bucket",
      objectKey: "sessions/session 1/media/artifact-1.png",
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      expiresInSeconds: 120,
      now,
    });

    expect(result.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 120);

    const url = new URL(result.url);
    expect(url.origin).toBe("https://account-123.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/media-bucket/sessions/session%201/media/artifact-1.png");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "access-key/20260411/auto/s3/aws4_request"
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260411T120000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });
});
