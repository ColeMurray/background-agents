import { describe, expect, it } from "vitest";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import type { ImageBuildProvider } from "./model";
import { evaluateImageBuildRebuildPolicy } from "./rebuild-policy";
import { COMPATIBLE_RUNTIME_VERSION } from "./test-helpers";

const unit = {
  scope: { kind: "repo" as const, id: "acme/web" },
  repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
  repositoriesFingerprint: "fp-current",
};

function row(overrides: Partial<ImageBuildRecordView> = {}): ImageBuildRecordView {
  return {
    id: "build-1",
    scope_kind: "repo",
    scope_id: "acme/web",
    provider: "modal",
    status: "ready",
    repositories_fingerprint: "fp-current",
    repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
    runtime_version: COMPATIBLE_RUNTIME_VERSION,
    build_duration_seconds: 1,
    error_message: null,
    created_at: 1,
    ...overrides,
  };
}

describe("evaluateImageBuildRebuildPolicy", () => {
  it("skips an active build for the active provider", () => {
    expect(evaluateImageBuildRebuildPolicy(unit, [row({ status: "building" })], "modal")).toEqual({
      type: "skip",
      reason: "building",
    });
  });

  it("rebuilds for a missing fingerprint, incompatible runtime, or malformed provenance", () => {
    expect(evaluateImageBuildRebuildPolicy(unit, [], "modal")).toMatchObject({
      type: "rebuild",
      reason: "missing_image",
    });
    expect(
      evaluateImageBuildRebuildPolicy(
        unit,
        [row({ runtime_version: "v56-managed-provider-runtime" })],
        "modal"
      )
    ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ repository_shas: "not-json" })], "modal")
    ).toMatchObject({ type: "rebuild", reason: "invalid_provenance" });
  });

  it("ignores ready images from another provider", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ provider: "vercel" })], "modal")
    ).toMatchObject({ type: "rebuild", reason: "missing_image" });
  });

  it("rebuilds each provider's pre-wraparound image and keeps the shared new generation", () => {
    const superseded: Array<[ImageBuildProvider, string]> = [
      ["modal", "v58-image-build-stdin-launch-vnc"],
      ["opencomputer", "v57-vnc-opencode-1-18-11"],
      ["vercel", "v57-vnc-opencode-1-18-11"],
    ];
    for (const [provider, runtime_version] of superseded) {
      expect(
        evaluateImageBuildRebuildPolicy(unit, [row({ provider, runtime_version })], provider)
      ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    }

    const current: Array<[ImageBuildProvider, string]> = [
      ["modal", "v59-opencode-1-18-18"],
      ["opencomputer", "v59-vnc-opencode-1-18-18"],
      ["vercel", "v59-vnc-opencode-1-18-18"],
    ];
    for (const [provider, runtime_version] of current) {
      expect(
        evaluateImageBuildRebuildPolicy(unit, [row({ provider, runtime_version })], provider).type
      ).toBe("check_branches");
    }
  });

  it("defers a compatible image to branch-head comparison", () => {
    const decision = evaluateImageBuildRebuildPolicy(unit, [row()], "modal");
    expect(decision.type).toBe("check_branches");
    if (decision.type === "check_branches") {
      expect(decision.recordedShas.get("acme/web")).toBe("abc123");
    }
  });
});
