import { describe, expect, it } from "vitest";
import type { Artifact } from "@/types/session";
import { resolveSessionActions } from "./session-actions";

function prArtifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/1",
    createdAt: 1,
    ...overrides,
  };
}

describe("resolveSessionActions", () => {
  it("links every PR, oldest first, labeled with number and head branch", () => {
    const second = prArtifact({
      id: "artifact-2",
      url: "https://github.com/acme/web/pull/2",
      metadata: { prNumber: 2, prState: "open", head: "feat/second" },
      createdAt: 2,
    });
    const first = prArtifact({
      id: "artifact-1",
      url: "https://github.com/acme/web/pull/1",
      metadata: { prNumber: 1, prState: "merged", head: "feat/first" },
      createdAt: 1,
    });

    const { prLinks } = resolveSessionActions([second, first]);

    expect(prLinks).toEqual([
      {
        id: "artifact-1",
        url: "https://github.com/acme/web/pull/1",
        label: "#1 · feat/first",
        prState: "merged",
      },
      {
        id: "artifact-2",
        url: "https://github.com/acme/web/pull/2",
        label: "#2 · feat/second",
        prState: "open",
      },
    ]);
  });

  it("prefixes PRs outside the primary repo with their repository", () => {
    const primaryPr = prArtifact({
      id: "artifact-web",
      url: "https://github.com/acme/web/pull/1",
      metadata: { prNumber: 1, repoOwner: "Acme", repoName: "Web" },
      createdAt: 1,
    });
    const otherPr = prArtifact({
      id: "artifact-api",
      url: "https://github.com/acme/api/pull/2",
      metadata: { prNumber: 2, repoOwner: "acme", repoName: "api" },
      createdAt: 2,
    });

    const { prLinks } = resolveSessionActions([primaryPr, otherPr], {
      repoOwner: "acme",
      repoName: "web",
    });

    expect(prLinks.map((link) => link.label)).toEqual(["#1", "acme/api#2"]);
  });

  it("drops PR artifacts without a safe external URL", () => {
    const unlinked = prArtifact({ id: "artifact-unlinked", url: null, createdAt: 1 });
    const unsafe = prArtifact({
      id: "artifact-unsafe",
      url: "javascript:alert(1)",
      createdAt: 2,
    });
    const linked = prArtifact({
      id: "artifact-linked",
      url: "https://github.com/acme/web/pull/3",
      metadata: { prNumber: 3 },
      createdAt: 3,
    });

    const { prLinks } = resolveSessionActions([unlinked, unsafe, linked]);

    expect(prLinks.map((link) => link.id)).toEqual(["artifact-linked"]);
  });

  it("labels legacy artifacts without a number as PR", () => {
    const legacy = prArtifact({ id: "artifact-legacy", metadata: {}, createdAt: 1 });

    const { prLinks } = resolveSessionActions([legacy]);

    expect(prLinks[0].label).toBe("PR");
  });
});
