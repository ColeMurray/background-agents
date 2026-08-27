import { describe, expect, it, vi } from "vitest";
import { parseArtifactMetadata, parseArtifactMetadataJson } from "./artifact-metadata";

describe("parseArtifactMetadataJson", () => {
  it("parses valid object metadata", () => {
    expect(parseArtifactMetadataJson('{"mimeType":"image/png","bytes":123}')).toEqual({
      mimeType: "image/png",
      bytes: 123,
    });
  });

  it("rejects non-object metadata", () => {
    expect(parseArtifactMetadataJson('[{"mimeType":"image/png"}]')).toBeNull();
  });

  it("preserves nullable object fields", () => {
    expect(parseArtifactMetadataJson('{"mimeType":null}')).toEqual({ mimeType: null });
  });

  it("throws invalid JSON for the caller to map to its existing invalid-json path", () => {
    expect(() => parseArtifactMetadataJson("{")).toThrow(SyntaxError);
  });
});

describe("parseArtifactMetadata", () => {
  function warnLog() {
    return { warn: vi.fn() };
  }

  it("returns the parsed metadata for a well-formed artifact", () => {
    const log = warnLog();

    expect(parseArtifactMetadata({ id: "a-1", metadata: '{"mimeType":"image/png"}' }, log)).toEqual(
      { mimeType: "image/png" }
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns null without warning when the artifact carries no metadata", () => {
    const log = warnLog();

    expect(parseArtifactMetadata({ id: "a-1", metadata: null }, log)).toBeNull();
    expect(parseArtifactMetadata({ id: "a-1", metadata: "" }, log)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns about an unexpected metadata shape and returns null", () => {
    const log = warnLog();

    expect(parseArtifactMetadata({ id: "a-1", metadata: "[1,2,3]" }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith("Invalid artifact metadata shape", {
      artifact_id: "a-1",
    });
  });

  it("warns about malformed JSON and returns null rather than throwing", () => {
    const log = warnLog();

    expect(parseArtifactMetadata({ id: "a-1", metadata: "{" }, log)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "Invalid artifact metadata JSON",
      expect.objectContaining({ artifact_id: "a-1", error: expect.any(String) })
    );
  });
});
