import { describe, expect, it } from "vitest";
import {
  buildMediaObjectKey,
  detectScreenshotFileType,
  detectVideoFileType,
  isSupportedScreenshotMimeType,
  isSupportedVideoMimeType,
  parseOptionalBoolean,
  parseOptionalViewport,
  parseVideoUploadMetadata,
} from "./media";

const MP4_SIGNATURE = Uint8Array.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
  0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
]);

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

  it("accepts only supported video mime types", () => {
    expect(isSupportedVideoMimeType("video/mp4")).toBe(true);
    expect(isSupportedVideoMimeType("video/webm")).toBe(false);
  });

  it("detects MP4 videos by ISO BMFF file type bytes", () => {
    expect(detectVideoFileType(MP4_SIGNATURE)).toEqual({
      mimeType: "video/mp4",
      extension: "mp4",
    });
  });

  it("parses required video metadata", () => {
    const formData = new FormData();
    formData.set("caption", "Menu opens after clicking settings");
    formData.set("durationMs", "2500");
    formData.set("recordingStartedAt", "1000");
    formData.set("recordingEndedAt", "3500");
    formData.set("dimensions", '{"width":1280,"height":720}');
    formData.set("truncated", "false");
    formData.set("sourceUrl", "https://example.com/start");
    formData.set("endUrl", "https://example.com/end");
    formData.set("hasAudio", "false");

    expect(parseVideoUploadMetadata(formData, 4000)).toEqual({
      caption: "Menu opens after clicking settings",
      durationMs: 2500,
      createdAt: 4000,
      recordingStartedAt: 1000,
      recordingEndedAt: 3500,
      dimensions: { width: 1280, height: 720 },
      truncated: false,
      sourceUrl: "https://example.com/start",
      endUrl: "https://example.com/end",
      hasAudio: false,
      captureSurface: "browser",
      source: "agent",
    });
  });

  it.each([
    ["missing caption", { caption: "" }, "caption is required"],
    ["non-positive duration", { durationMs: "0" }, "durationMs must be a positive number"],
    ["decimal duration", { durationMs: "2500.5" }, "durationMs must be a positive integer"],
    ["exponent duration", { durationMs: "1e3" }, "durationMs must be a positive integer"],
    ["duration above maximum", { durationMs: "90001" }, "durationMs must be 90000 or less"],
    [
      "invalid dimensions",
      { dimensions: '{"width":0,"height":720}' },
      "dimensions must include positive integer width and height",
    ],
    [
      "fractional dimensions",
      { dimensions: '{"width":0.4,"height":720}' },
      "dimensions must include positive integer width and height",
    ],
    ["invalid source URL", { sourceUrl: "not-a-url" }, "sourceUrl must be a valid URL"],
    ["audio present", { hasAudio: "true" }, "hasAudio must be false"],
    [
      "timestamp span above maximum",
      { recordingEndedAt: "93001" },
      "recording timestamps must span 90000ms or less",
    ],
    [
      "duration exceeds timestamp span",
      { durationMs: "5000" },
      "durationMs must not exceed the recording timestamp span",
    ],
  ])("rejects invalid video metadata: %s", (_label, overrides, message) => {
    const formData = new FormData();
    formData.set("caption", "Menu opens after clicking settings");
    formData.set("durationMs", "2500");
    formData.set("recordingStartedAt", "1000");
    formData.set("recordingEndedAt", "3500");
    formData.set("dimensions", '{"width":1280,"height":720}');
    formData.set("truncated", "false");

    for (const [name, value] of Object.entries(overrides)) {
      formData.set(name, value);
    }

    expect(() => parseVideoUploadMetadata(formData, 4000)).toThrow(message);
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
