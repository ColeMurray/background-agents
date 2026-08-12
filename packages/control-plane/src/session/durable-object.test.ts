import { describe, expect, it } from "vitest";
import { parseArtifactMetadataJson } from "./artifact-metadata";

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
