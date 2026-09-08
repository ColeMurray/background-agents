import { describe, expect, it } from "vitest";
import { toUiArtifact } from "./artifact-metadata";

describe("toUiArtifact", () => {
  it("maps PR metadata and derives prState from tracked lifecycle over the legacy key", () => {
    const artifact = toUiArtifact({
      id: "artifact-pr-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      metadata: {
        number: 1,
        state: "open",
        lifecycleState: "open",
        isDraft: true,
        head: "feature",
        base: "main",
      },
      createdAt: 100,
      updatedAt: 200,
    });
    expect(artifact).toEqual({
      id: "artifact-pr-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      createdAt: 100,
      updatedAt: 200,
      metadata: expect.objectContaining({
        prNumber: 1,
        prState: "draft",
        head: "feature",
        base: "main",
      }),
    });
  });

  it("falls back to the legacy state key on artifacts without lifecycle tracking", () => {
    const artifact = toUiArtifact({
      id: "artifact-pr-2",
      type: "pr",
      url: "https://github.com/acme/web/pull/2",
      metadata: { number: 2, state: "closed" },
      createdAt: 100,
    });
    expect(artifact.metadata?.prState).toBe("closed");
  });

  it("derives prState merged from tracked lifecycle metadata", () => {
    const artifact = toUiArtifact({
      id: "artifact-pr-3",
      type: "pr",
      url: "https://github.com/acme/web/pull/3",
      // Stale legacy display key vs. tracked lifecycle: lifecycle wins.
      metadata: { number: 3, state: "open", lifecycleState: "merged" },
      createdAt: 100,
    });
    expect(artifact.metadata?.prState).toBe("merged");
  });

  it("keeps hasAudio only as an explicit false flag", () => {
    const silent = toUiArtifact({
      id: "artifact-video-1",
      type: "video",
      url: "sessions/s/media/v1.mp4",
      metadata: { mimeType: "video/mp4", hasAudio: false },
      createdAt: 100,
    });
    expect(silent.metadata).toEqual(expect.objectContaining({ hasAudio: false }));

    // true is the default assumption, so it narrows to undefined.
    const withAudio = toUiArtifact({
      id: "artifact-video-2",
      type: "video",
      url: "sessions/s/media/v2.mp4",
      metadata: { mimeType: "video/mp4", hasAudio: true },
      createdAt: 100,
    });
    expect(withAudio.metadata).toEqual(expect.objectContaining({ hasAudio: undefined }));
  });

  it("drops wrong-type metadata fields during narrowing", () => {
    const artifact = toUiArtifact({
      id: "artifact-shot-1",
      type: "screenshot",
      url: "sessions/s/media/a.png",
      metadata: {
        mimeType: "image/png",
        sizeBytes: "five",
        viewport: "not-an-object",
        caption: 42,
      },
      createdAt: 100,
    });
    expect(artifact.metadata).toEqual(
      expect.objectContaining({
        mimeType: "image/png",
        sizeBytes: undefined,
        viewport: undefined,
        caption: undefined,
      })
    );
  });

  it("leaves metadata undefined when the artifact has none", () => {
    const artifact = toUiArtifact({
      id: "artifact-branch-1",
      type: "branch",
      url: null,
      metadata: null,
      createdAt: 100,
    });
    expect(artifact.metadata).toBeUndefined();
  });
});
