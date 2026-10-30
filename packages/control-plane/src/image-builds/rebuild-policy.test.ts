import { describe, expect, it } from "vitest";
import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import type { ImageBuildProvider } from "./model";
import { evaluateImageBuildRebuildPolicy, resolveMinRebuildIntervalMs } from "./rebuild-policy";
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

  it.each([
    "v76-child-output-discovery",
    "v77-codex-pinned-binary",
    "v78-tunnel-environment-recovery",
  ])(
    "rebuilds outdated Modal image %s even when repository SHAs are unchanged",
    (runtimeVersion) => {
      expect(evaluateImageBuildRebuildPolicy(unit, [row({ runtimeVersion })], "modal")).toEqual({
        type: "rebuild",
        reason: "runtime_incompatible",
      });
    }
  );

  it("rebuilds each provider's pre-wraparound image and keeps the shared new generation", () => {
    const superseded: Array<[ImageBuildProvider, string]> = [
      ["modal", "v58-image-build-stdin-launch-vnc"],
      ["vercel", "v57-vnc-opencode-1-18-11"],
    ];
    for (const [provider, runtimeVersion] of superseded) {
      expect(
        evaluateImageBuildRebuildPolicy(unit, [row({ provider, runtimeVersion })], provider)
      ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    }

    const current: Array<[ImageBuildProvider, string]> = [
      ["modal", COMPATIBLE_RUNTIME_VERSION],
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

describe("minimum rebuild interval", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_000 * HOUR;

  it("skips the branch check while the ready image is younger than the interval", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ createdAt: now - 2 * HOUR })], "modal", {
        minRebuildIntervalMs: 24 * HOUR,
        now,
      })
    ).toEqual({ type: "skip", reason: "fresh" });
  });

  it("checks branches once the ready image is older than the interval", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ createdAt: now - 25 * HOUR })], "modal", {
        minRebuildIntervalMs: 24 * HOUR,
        now,
      })
    ).toMatchObject({ type: "check_branches" });
  });

  it("never delays a rebuild for a missing or incompatible image", () => {
    const options = { minRebuildIntervalMs: 24 * HOUR, now };
    expect(evaluateImageBuildRebuildPolicy(unit, [], "modal", options)).toMatchObject({
      type: "rebuild",
      reason: "missing_image",
    });
    expect(
      evaluateImageBuildRebuildPolicy(
        unit,
        [row({ createdAt: now - HOUR, runtimeVersion: "v1-old" })],
        "modal",
        options
      )
    ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
  });

  it("keeps the old behavior without an interval", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ createdAt: now - HOUR })], "modal")
    ).toMatchObject({ type: "check_branches" });
  });

  it("reads IMAGE_BUILD_MIN_REBUILD_INTERVAL_MS, treating blank or invalid values as no interval", () => {
    expect(resolveMinRebuildIntervalMs({ IMAGE_BUILD_MIN_REBUILD_INTERVAL_MS: "604800000" })).toBe(
      168 * HOUR
    );
    expect(resolveMinRebuildIntervalMs({ IMAGE_BUILD_MIN_REBUILD_INTERVAL_MS: " 3600000 " })).toBe(
      HOUR
    );
    for (const value of [undefined, "", "abc", "-1", "0"]) {
      expect(resolveMinRebuildIntervalMs({ IMAGE_BUILD_MIN_REBUILD_INTERVAL_MS: value })).toBe(0);
    }
  });
});
