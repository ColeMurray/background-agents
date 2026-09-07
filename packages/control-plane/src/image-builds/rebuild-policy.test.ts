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
    scopeKind: "repo",
    scopeId: "acme/web",
    provider: "modal",
    status: "ready",
    repositoriesFingerprint: "fp-current",
    repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: COMPATIBLE_RUNTIME_VERSION,
    buildDurationSeconds: 1,
    errorMessage: null,
    createdAt: 1,
    ...overrides,
  };
}

describe("evaluateImageBuildRebuildPolicy", () => {
  it("rebuilds release drift without changing the runtime compatibility floor", () => {
    const legacy = row();
    expect(evaluateImageBuildRebuildPolicy(unit, [legacy], "modal", "new-release")).toEqual({
      type: "rebuild",
      reason: "base_release_changed",
    });
    expect(evaluateImageBuildRebuildPolicy(unit, [legacy], "modal").type).toBe("check_branches");
    expect(
      evaluateImageBuildRebuildPolicy(
        unit,
        [row({ baseReleaseId: "new-release" })],
        "modal",
        "new-release"
      ).type
    ).toBe("check_branches");
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ status: "building" })], "modal", "new-release")
        .type
    ).toBe("skip");
  });
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
        [row({ runtimeVersion: "v56-managed-provider-runtime" })],
        "modal"
      )
    ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ repositoryShas: null })], "modal")
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
    for (const [provider, runtimeVersion] of superseded) {
      expect(
        evaluateImageBuildRebuildPolicy(unit, [row({ provider, runtimeVersion })], provider)
      ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    }

    const current: Array<[ImageBuildProvider, string]> = [
      ["modal", COMPATIBLE_RUNTIME_VERSION],
      ["opencomputer", COMPATIBLE_RUNTIME_VERSION],
      ["vercel", COMPATIBLE_RUNTIME_VERSION],
    ];
    for (const [provider, runtimeVersion] of current) {
      expect(
        evaluateImageBuildRebuildPolicy(unit, [row({ provider, runtimeVersion })], provider).type
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
