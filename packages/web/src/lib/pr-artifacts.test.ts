import { describe, expect, it } from "vitest";
import type { Artifact } from "@/types/session";
import { findPrArtifactForRepo } from "./pr-artifacts";

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/7",
    createdAt: 1,
    ...overrides,
  };
}

describe("findPrArtifactForRepo", () => {
  it("matches by repo identity, case-insensitively", () => {
    const match = artifact({
      id: "artifact-web",
      metadata: { repoOwner: "Acme", repoName: "Web" },
    });
    const other = artifact({
      id: "artifact-api",
      metadata: { repoOwner: "acme", repoName: "api" },
    });

    const found = findPrArtifactForRepo(
      [other, match],
      { repoOwner: "acme", repoName: "web" },
      false
    );

    expect(found?.id).toBe("artifact-web");
  });

  it("attributes identity-less legacy metadata to the primary repository only", () => {
    const legacy = artifact({ id: "artifact-legacy", metadata: {} });
    const target = { repoOwner: "acme", repoName: "web" };

    expect(findPrArtifactForRepo([legacy], target, true)?.id).toBe("artifact-legacy");
    expect(findPrArtifactForRepo([legacy], target, false)).toBeUndefined();
  });

  it("ignores non-PR artifacts", () => {
    const branch = artifact({
      id: "artifact-branch",
      type: "branch",
      metadata: { repoOwner: "acme", repoName: "web" },
    });

    expect(
      findPrArtifactForRepo([branch], { repoOwner: "acme", repoName: "web" }, true)
    ).toBeUndefined();
  });
});
