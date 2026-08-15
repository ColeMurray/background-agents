import { describe, expect, it } from "vitest";
import type { Artifact } from "@/types/session";
import { listPrArtifacts, listPrArtifactsForRepo } from "./pr-artifacts";

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

describe("listPrArtifacts", () => {
  it("returns every PR artifact across repositories, oldest first", () => {
    const webPr = artifact({
      id: "artifact-web",
      createdAt: 2,
      metadata: { repoOwner: "acme", repoName: "web", prNumber: 2 },
    });
    const apiPr = artifact({
      id: "artifact-api",
      createdAt: 1,
      metadata: { repoOwner: "acme", repoName: "api", prNumber: 1 },
    });
    const branch = artifact({ id: "artifact-branch", type: "branch", createdAt: 0 });

    expect(listPrArtifacts([webPr, branch, apiPr]).map((entry) => entry.id)).toEqual([
      "artifact-api",
      "artifact-web",
    ]);
  });
});
