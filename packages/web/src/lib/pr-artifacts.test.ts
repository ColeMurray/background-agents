import { describe, expect, it } from "vitest";
import type { Artifact } from "@/types/session";
import { findLatestOpenPrArtifact, listPrArtifactsForRepo } from "./pr-artifacts";

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/7",
    createdAt: 1,
    ...overrides,
  };
}

describe("listPrArtifactsForRepo", () => {
  it("matches by repo identity, case-insensitively", () => {
    const match = artifact({
      id: "artifact-web",
      metadata: { repoOwner: "Acme", repoName: "Web" },
    });
    const other = artifact({
      id: "artifact-api",
      metadata: { repoOwner: "acme", repoName: "api" },
    });

    const listed = listPrArtifactsForRepo(
      [other, match],
      { repoOwner: "acme", repoName: "web" },
      false
    );

    expect(listed.map((entry) => entry.id)).toEqual(["artifact-web"]);
  });

  it("ignores non-PR artifacts", () => {
    const branch = artifact({
      id: "artifact-branch",
      type: "branch",
      metadata: { repoOwner: "acme", repoName: "web" },
    });

    expect(
      listPrArtifactsForRepo([branch], { repoOwner: "acme", repoName: "web" }, true)
    ).toHaveLength(0);
  });

  it("returns every matching PR artifact, oldest first", () => {
    const first = artifact({
      id: "artifact-1",
      createdAt: 1,
      metadata: { repoOwner: "acme", repoName: "web", prNumber: 1 },
    });
    const second = artifact({
      id: "artifact-2",
      createdAt: 2,
      metadata: { repoOwner: "acme", repoName: "web", prNumber: 2 },
    });
    const other = artifact({
      id: "artifact-api",
      createdAt: 3,
      metadata: { repoOwner: "acme", repoName: "api", prNumber: 9 },
    });

    const listed = listPrArtifactsForRepo(
      [second, other, first],
      { repoOwner: "acme", repoName: "web" },
      false
    );

    expect(listed.map((entry) => entry.id)).toEqual(["artifact-1", "artifact-2"]);
  });

  it("attributes identity-less legacy metadata to the primary repository only", () => {
    const legacy = artifact({ id: "artifact-legacy", metadata: {} });
    const target = { repoOwner: "acme", repoName: "web" };

    expect(listPrArtifactsForRepo([legacy], target, true)).toHaveLength(1);
    expect(listPrArtifactsForRepo([legacy], target, false)).toHaveLength(0);
  });
});

describe("findLatestOpenPrArtifact", () => {
  it("prefers the most recent open PR over a newer merged one", () => {
    const olderOpen = artifact({
      id: "artifact-older-open",
      createdAt: 1,
      metadata: { prNumber: 1, prState: "open" },
    });
    const open = artifact({
      id: "artifact-open",
      createdAt: 2,
      metadata: { prNumber: 2, prState: "open" },
    });
    const newerMerged = artifact({
      id: "artifact-merged",
      createdAt: 3,
      metadata: { prNumber: 3, prState: "merged" },
    });

    expect(findLatestOpenPrArtifact([olderOpen, newerMerged, open])?.id).toBe("artifact-open");
  });

  it("counts drafts as open", () => {
    const draft = artifact({
      id: "artifact-draft",
      createdAt: 2,
      metadata: { prNumber: 2, prState: "draft" },
    });
    const closed = artifact({
      id: "artifact-closed",
      createdAt: 3,
      metadata: { prNumber: 3, prState: "closed" },
    });

    expect(findLatestOpenPrArtifact([draft, closed])?.id).toBe("artifact-draft");
  });

  it("falls back to the most recent PR when none are open", () => {
    const merged = artifact({
      id: "artifact-m1",
      createdAt: 1,
      metadata: { prNumber: 1, prState: "merged" },
    });
    const closed = artifact({
      id: "artifact-m2",
      createdAt: 2,
      metadata: { prNumber: 2, prState: "closed" },
    });

    expect(findLatestOpenPrArtifact([merged, closed])?.id).toBe("artifact-m2");
  });

  it("scopes to the target repository when one is given", () => {
    const webPr = artifact({
      id: "artifact-web",
      createdAt: 1,
      metadata: { repoOwner: "acme", repoName: "web", prNumber: 1, prState: "open" },
    });
    const apiPr = artifact({
      id: "artifact-api",
      createdAt: 2,
      metadata: { repoOwner: "acme", repoName: "api", prNumber: 2, prState: "open" },
    });

    const found = findLatestOpenPrArtifact([webPr, apiPr], { repoOwner: "acme", repoName: "web" });

    expect(found?.id).toBe("artifact-web");
  });
});
