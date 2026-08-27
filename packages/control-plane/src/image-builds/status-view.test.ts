import { describe, expect, it } from "vitest";
import { toImageBuildRecordView } from "./status-view";

const row = {
  id: "build-1",
  scope_kind: "repo" as const,
  scope_id: "acme/web",
  provider: "modal" as const,
  status: "ready" as const,
  repositories_fingerprint: "fp-current",
  repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
  runtime_version: "60",
  build_duration_seconds: 42,
  error_message: null,
  created_at: 1700000000000,
};

describe("toImageBuildRecordView", () => {
  it("maps a storage row to the public DTO and decodes provenance", () => {
    expect(toImageBuildRecordView(row)).toEqual({
      id: "build-1",
      scopeKind: "repo",
      scopeId: "acme/web",
      provider: "modal",
      status: "ready",
      repositoriesFingerprint: "fp-current",
      repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
      runtimeVersion: "60",
      buildDurationSeconds: 42,
      errorMessage: null,
      createdAt: 1700000000000,
    });
  });

  it("preserves empty provenance", () => {
    expect(toImageBuildRecordView({ ...row, repository_shas: "[]" }).repositoryShas).toEqual([]);
  });

  it.each(["not-json", JSON.stringify([{ repoOwner: "acme", repoName: "web" }])])(
    "maps malformed stored provenance to null",
    (repositoryShas) => {
      expect(
        toImageBuildRecordView({ ...row, repository_shas: repositoryShas }).repositoryShas
      ).toBeNull();
    }
  );
});
