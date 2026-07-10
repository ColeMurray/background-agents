import { describe, expect, it } from "vitest";
import type { Environment, ImageBuildRecordView, ImageBuildStatus } from "@open-inspect/shared";
import { foldImageBuildStatusByScope, imageBuildScopeKey } from "@/lib/image-builds";
import { describeEnvironment } from "./use-session-target-picker";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: "Stack",
    description: null,
    prebuildEnabled: true,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    repositories: [
      { repoOwner: "acme", repoName: "web", repoId: 1, baseBranch: "main" },
      { repoOwner: "acme", repoName: "api", repoId: 2, baseBranch: "main" },
    ],
    ...overrides,
  };
}

function statusMap(status: ImageBuildStatus): Map<string, ImageBuildStatus> {
  return new Map([[imageBuildScopeKey("environment", "env-1"), status]]);
}

describe("describeEnvironment", () => {
  it("shows the repository count without prebuild state when prebuilds are off", () => {
    expect(describeEnvironment(environment({ prebuildEnabled: false }), new Map())).toBe(
      "2 repositories"
    );
  });

  it("shows prebuilt for a ready scope", () => {
    expect(describeEnvironment(environment(), statusMap("ready"))).toBe(
      "2 repositories · prebuilt"
    );
  });

  it("shows prebuild building for a building scope", () => {
    expect(describeEnvironment(environment(), statusMap("building"))).toBe(
      "2 repositories · prebuild building"
    );
  });

  it("shows prebuild failed for a failed scope", () => {
    expect(describeEnvironment(environment(), statusMap("failed"))).toBe(
      "2 repositories · prebuild failed"
    );
  });

  it("falls back to prebuilds on when the scope has no build rows", () => {
    expect(describeEnvironment(environment(), new Map())).toBe("2 repositories · prebuilds on");
  });

  it("surfaces a failed-only aggregate through the fold", () => {
    const failedRow: ImageBuildRecordView = {
      id: "build-1",
      scope_kind: "environment",
      scope_id: "env-1",
      provider: "modal",
      status: "failed",
      repository_shas: "[]",
      runtime_version: "60",
      build_duration_seconds: null,
      error_message: "boom",
      created_at: 1700000000000,
    };

    const folded = foldImageBuildStatusByScope([failedRow]);

    expect(describeEnvironment(environment(), folded)).toBe("2 repositories · prebuild failed");
  });
});
