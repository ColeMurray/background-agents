import { describe, expect, it } from "vitest";
import { findPrArtifactForRepo, listPrArtifactsForHead } from "./pr-artifacts";
import type { RepoIdentity } from "./repository-target";
import type { ArtifactRow } from "./types";

const targetRepo: RepoIdentity = { repoOwner: "acme", repoName: "web" };

function artifact(overrides: Partial<ArtifactRow>): ArtifactRow {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/1",
    metadata: null,
    created_at: 100,
    updated_at: 100,
    ...overrides,
  };
}

describe("PR artifact metadata parsing", () => {
  it("matches a PR artifact whose stored metadata belongs to the target repo", () => {
    const row = artifact({
      metadata: JSON.stringify({ repoOwner: "acme", repoName: "web" }),
    });

    expect(findPrArtifactForRepo([row], targetRepo, false)).toBe(row);
  });

  it("rejects malformed repo identity metadata without matching the artifact", () => {
    const rows = [
      artifact({ id: "array", metadata: JSON.stringify([]) }),
      artifact({ id: "partial", metadata: JSON.stringify({ repoOwner: "acme" }) }),
      artifact({ id: "wrong-type", metadata: JSON.stringify({ repoOwner: "acme", repoName: 42 }) }),
    ];

    expect(findPrArtifactForRepo(rows, targetRepo, false)).toBeUndefined();
  });

  it("preserves legacy null metadata for primary-repo PR artifact matching", () => {
    const row = artifact({ metadata: null });

    expect(findPrArtifactForRepo([row], targetRepo, true)).toBe(row);
  });

  it("uses parsed metadata when listing matching head-branch PR artifacts", () => {
    const row = artifact({
      metadata: JSON.stringify({
        repoOwner: "acme",
        repoName: "web",
        head: "feature",
        number: 12,
        lifecycleState: "open",
        isDraft: true,
        base: "main",
        repositoryExternalId: "repo-1",
      }),
    });

    expect(
      listPrArtifactsForHead([row], targetRepo, false, {
        headBranch: "feature",
        generatedHeadBranch: "fallback",
      })
    ).toEqual([
      {
        artifact: row,
        prNumber: 12,
        lifecycleState: "open",
        isDraft: true,
        baseBranch: "main",
        repositoryExternalId: "repo-1",
      },
    ]);
  });
});
