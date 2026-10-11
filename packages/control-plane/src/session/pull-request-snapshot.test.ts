import { describe, expect, it } from "vitest";
import { parsePullRequestArtifactMetadata } from "./pull-request-snapshot";

describe("parsePullRequestArtifactMetadata", () => {
  it("parses object metadata and preserves unknown fields", () => {
    expect(parsePullRequestArtifactMetadata('{"state":"open","legacy":42}')).toEqual({
      state: "open",
      legacy: 42,
    });
  });

  it("rejects non-object metadata", () => {
    expect(parsePullRequestArtifactMetadata("[]")).toEqual({});
    expect(parsePullRequestArtifactMetadata("null")).toEqual({});
  });

  it("rejects malformed JSON", () => {
    expect(parsePullRequestArtifactMetadata("not json")).toEqual({});
  });
});
