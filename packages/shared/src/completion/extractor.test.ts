import { describe, expect, it } from "vitest";
import { toArtifactType, toEventArtifactInfo } from "./extractor";

describe("completion artifact type narrowing", () => {
  it("recognizes video artifacts", () => {
    expect(toArtifactType("video")).toBe("video");
  });

  it("omits video artifacts from completion artifact summaries like screenshots", () => {
    expect(toEventArtifactInfo({ artifactType: "video", url: "sessions/s1/media/a1.mp4" })).toBe(
      null
    );
  });
});
