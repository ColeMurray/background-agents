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
