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
  it("targets the most recent open PR, not the first artifact", () => {
    const merged = prArtifact({
      id: "artifact-merged",
      url: "https://github.com/acme/web/pull/1",
      metadata: { prNumber: 1, prState: "merged" },
      createdAt: 1,
    });
    const open = prArtifact({
      id: "artifact-open",
      url: "https://github.com/acme/web/pull/2",
      metadata: { prNumber: 2, prState: "open" },
      createdAt: 2,
    });

    const actions = resolveSessionActions([merged, open]);

    expect(actions.prUrl).toBe("https://github.com/acme/web/pull/2");
  });

  it("falls back to the most recent PR when none are open", () => {
    const older = prArtifact({
      id: "artifact-older",
      url: "https://github.com/acme/web/pull/1",
      metadata: { prNumber: 1, prState: "merged" },
      createdAt: 1,
    });
    const newer = prArtifact({
      id: "artifact-newer",
      url: "https://github.com/acme/web/pull/2",
      metadata: { prNumber: 2, prState: "closed" },
      createdAt: 2,
    });

    const actions = resolveSessionActions([older, newer]);

    expect(actions.prUrl).toBe("https://github.com/acme/web/pull/2");
  });

  it("scopes the PR to the primary repo when one is given", () => {
    const primaryPr = prArtifact({
      id: "artifact-web",
      url: "https://github.com/acme/web/pull/1",
      metadata: { prNumber: 1, prState: "open", repoOwner: "acme", repoName: "web" },
      createdAt: 1,
    });
    const otherPr = prArtifact({
      id: "artifact-api",
      url: "https://github.com/acme/api/pull/2",
      metadata: { prNumber: 2, prState: "open", repoOwner: "acme", repoName: "api" },
      createdAt: 2,
    });

    const actions = resolveSessionActions([otherPr, primaryPr], {
      repoOwner: "acme",
      repoName: "web",
    });

    expect(actions.prUrl).toBe("https://github.com/acme/web/pull/1");
  });
});
