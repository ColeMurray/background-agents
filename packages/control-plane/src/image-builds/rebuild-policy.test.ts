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

const NO_INTERVAL = { now: 0, minRebuildIntervalMs: 0 };

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
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ status: "building" })], "modal", NO_INTERVAL)
    ).toEqual({
      type: "skip",
      reason: "building",
    });
  });

  it("rebuilds for a missing fingerprint, incompatible runtime, or malformed provenance", () => {
    expect(evaluateImageBuildRebuildPolicy(unit, [], "modal", NO_INTERVAL)).toMatchObject({
      type: "rebuild",
      reason: "missing_image",
    });
    expect(
      evaluateImageBuildRebuildPolicy(
        unit,
        [row({ runtimeVersion: "v56-managed-provider-runtime" })],
        "modal",
        NO_INTERVAL
      )
    ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ repositoryShas: null })], "modal", NO_INTERVAL)
    ).toMatchObject({ type: "rebuild", reason: "invalid_provenance" });
  });

  it("ignores ready images from another provider", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ provider: "vercel" })], "modal", NO_INTERVAL)
    ).toMatchObject({ type: "rebuild", reason: "missing_image" });
  });

  it.each([
    "v76-child-output-discovery",
    "v77-codex-pinned-binary",
    "v78-tunnel-environment-recovery",
  ])(
    "rebuilds outdated Modal image %s even when repository SHAs are unchanged",
    (runtimeVersion) => {
      expect(
        evaluateImageBuildRebuildPolicy(unit, [row({ runtimeVersion })], "modal", NO_INTERVAL)
      ).toEqual({
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
        evaluateImageBuildRebuildPolicy(
          unit,
          [row({ provider, runtimeVersion })],
          provider,
          NO_INTERVAL
        )
      ).toMatchObject({ type: "rebuild", reason: "runtime_incompatible" });
    }

    const current: Array<[ImageBuildProvider, string]> = [
      ["modal", COMPATIBLE_RUNTIME_VERSION],
      ["vercel", COMPATIBLE_RUNTIME_VERSION],
    ];
    for (const [provider, runtimeVersion] of current) {
      expect(
        evaluateImageBuildRebuildPolicy(
          unit,
          [row({ provider, runtimeVersion })],
          provider,
          NO_INTERVAL
        ).type
      ).toBe("check_branches");
    }
  });

  it("defers a compatible image to branch-head comparison", () => {
    const decision = evaluateImageBuildRebuildPolicy(unit, [row()], "modal", NO_INTERVAL);
    expect(decision.type).toBe("check_branches");
    if (decision.type === "check_branches") {
      expect(decision.recordedShas.get("acme/web")).toBe("abc123");
    }
  });
});

describe("minimum rebuild interval", () => {
  const HOUR = 60 * 60 * 1000;
  const now = 1_000 * HOUR;
  const clock = { now, minRebuildIntervalMs: 24 * HOUR };
  const young = { createdAt: now - HOUR };

  it("skips the branch check while the ready image is younger than the interval", () => {
    expect(evaluateImageBuildRebuildPolicy(unit, [row(young)], "modal", clock)).toEqual({
      type: "skip",
      reason: "min_rebuild_interval",
    });
  });

  it("checks branches once the ready image is exactly as old as the interval", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row({ createdAt: now - 24 * HOUR })], "modal", clock)
    ).toMatchObject({ type: "check_branches" });
  });

  it("checks branches when the interval is 0", () => {
    expect(
      evaluateImageBuildRebuildPolicy(unit, [row(young)], "modal", {
        now,
        minRebuildIntervalMs: 0,
      })
    ).toMatchObject({ type: "check_branches" });
  });

  it.each<[string, ImageBuildRecordView[], object]>([
    ["no image", [], { type: "rebuild", reason: "missing_image" }],
    [
      "repository set or base branch changed",
      [row({ ...young, repositoriesFingerprint: "fp-old" })],
      { type: "rebuild", reason: "missing_image" },
    ],
    [
      "runtime below the rebuild floor",
      [row({ ...young, runtimeVersion: "v1-old" })],
      { type: "rebuild", reason: "runtime_incompatible" },
    ],
    [
      "missing provenance",
      [row({ ...young, repositoryShas: null })],
      { type: "rebuild", reason: "invalid_provenance" },
    ],
    [
      "provenance missing a scope repository",
      [
        row({
          ...young,
          repositoryShas: [{ repoOwner: "acme", repoName: "other", baseSha: "abc123" }],
        }),
      ],
      { type: "rebuild", reason: "invalid_provenance" },
    ],
    [
      "build in flight",
      [row({ id: "build-2", status: "building", createdAt: now }), row(young)],
      { type: "skip", reason: "building" },
    ],
  ])("%s is not delayed by the interval", (_name, rows, expected) => {
    expect(evaluateImageBuildRebuildPolicy(unit, rows, "modal", clock)).toEqual(expected);
  });
});
