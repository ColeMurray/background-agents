import { describe, expect, it } from "vitest";
import {
  buildMediaObjectKey,
  detectScreenshotFileType,
  isSupportedScreenshotMimeType,
  parseOptionalBoolean,
  parseOptionalViewport,
} from "./media";

describe("media helpers", () => {
  it("builds session-scoped media object keys", () => {
    expect(buildMediaObjectKey("session-1", "artifact-1", "png")).toBe(
      "sessions/session-1/media/artifact-1.png"
    );
  });

  it("accepts only supported screenshot mime types", () => {
    expect(isSupportedScreenshotMimeType("image/png")).toBe(true);
    expect(isSupportedScreenshotMimeType("image/jpeg")).toBe(true);
    expect(isSupportedScreenshotMimeType("image/webp")).toBe(true);
    expect(isSupportedScreenshotMimeType("image/gif")).toBe(false);
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
});
