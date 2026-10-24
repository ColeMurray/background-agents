import { describe, expect, it } from "vitest";
import type { SessionDiffManifest } from "@open-inspect/shared/types/session-diffs";
import { resolveDiffFileLink } from "./diff-file-links";

function manifest(): SessionDiffManifest {
  const repository = (position: number, repoOwner: string) => ({
    status: "ready" as const,
    position,
    repoOwner,
    repoName: "app",
    baseSha: "a".repeat(40),
    headSha: "a".repeat(40),
    truncated: false,
    omittedFileCount: 0,
    files: [
      {
        id: `file-${position}`,
        path: "src/index.ts",
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        renderState: "renderable" as const,
      },
    ],
  });
  return {
    version: 1,
    revisionId: "revision-1",
    triggerMessageId: null,
    capturedAt: 1,
    repositories: [repository(0, "acme"), repository(1, "globex")],
  };
}

describe("resolveDiffFileLink", () => {
  it("resolves position-rooted repository links before legacy name roots", () => {
    expect(resolveDiffFileLink(manifest(), "/workspace/repos/1/src/index.ts")).toEqual({
      repositoryPosition: 1,
      path: "src/index.ts",
    });
  });

  it("retains legacy name-root links and resolves duplicate names to the primary", () => {
    expect(resolveDiffFileLink(manifest(), "/workspace/app/src/index.ts")).toEqual({
      repositoryPosition: 0,
      path: "src/index.ts",
    });
  });
});
