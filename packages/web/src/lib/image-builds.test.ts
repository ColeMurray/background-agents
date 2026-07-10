import { describe, expect, it } from "vitest";
import type { ImageBuildRecordView } from "@open-inspect/shared";
import {
  excludeSupersededBuilds,
  foldImageBuildStatusByScope,
  imageBuildScopeKey,
  parsePrimaryBuildSha,
} from "./image-builds";

function record(overrides: Partial<ImageBuildRecordView>): ImageBuildRecordView {
  return {
    id: "build-1",
    scope_kind: "environment",
    scope_id: "env-1",
    provider: "modal",
    status: "ready",
    repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
    runtime_version: "60",
    build_duration_seconds: 42,
    error_message: null,
    created_at: 1700000000000,
    ...overrides,
  };
}

describe("excludeSupersededBuilds", () => {
  it("drops superseded rows and keeps every other status", () => {
    const rows = [
      record({ id: "a", status: "ready" }),
      record({ id: "b", status: "superseded" }),
      record({ id: "c", status: "building" }),
      record({ id: "d", status: "failed" }),
    ];

    expect(excludeSupersededBuilds(rows).map((row) => row.id)).toEqual(["a", "c", "d"]);
  });
});

describe("foldImageBuildStatusByScope", () => {
  it("folds a failed-only scope to failed (visible in the aggregate)", () => {
    const folded = foldImageBuildStatusByScope([record({ status: "failed" })]);

    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("failed");
  });

  it("ready beats building beats failed regardless of row order", () => {
    const folded = foldImageBuildStatusByScope([
      record({ id: "a", status: "failed", scope_id: "env-ready" }),
      record({ id: "b", status: "building", scope_id: "env-ready" }),
      record({ id: "c", status: "ready", scope_id: "env-ready" }),
      record({ id: "d", status: "failed", scope_id: "env-building" }),
      record({ id: "e", status: "building", scope_id: "env-building" }),
    ]);

    expect(folded.get(imageBuildScopeKey("environment", "env-ready"))).toBe("ready");
    expect(folded.get(imageBuildScopeKey("environment", "env-building"))).toBe("building");
  });

  it("folds repo and environment scopes independently", () => {
    const folded = foldImageBuildStatusByScope([
      record({ id: "a", scope_kind: "repo", scope_id: "acme/web", status: "failed" }),
      record({ id: "b", scope_kind: "environment", scope_id: "env-1", status: "ready" }),
    ]);

    expect(folded.get(imageBuildScopeKey("repo", "acme/web"))).toBe("failed");
    expect(folded.get(imageBuildScopeKey("environment", "env-1"))).toBe("ready");
  });
});

describe("parsePrimaryBuildSha", () => {
  it("reads the primary repository's baseSha", () => {
    const shas = JSON.stringify([
      { repoOwner: "acme", repoName: "web", baseSha: "abc123def" },
      { repoOwner: "acme", repoName: "api", baseSha: "fff000" },
    ]);

    expect(parsePrimaryBuildSha(shas)).toBe("abc123def");
  });

  it("returns null for an empty document", () => {
    expect(parsePrimaryBuildSha("[]")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parsePrimaryBuildSha("not json")).toBeNull();
  });

  it("returns null when the primary entry has no string baseSha", () => {
    expect(parsePrimaryBuildSha(JSON.stringify([{ repoOwner: "acme" }]))).toBeNull();
    expect(parsePrimaryBuildSha(JSON.stringify([{ baseSha: 42 }]))).toBeNull();
  });
});
