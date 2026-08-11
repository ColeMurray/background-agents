import { describe, expect, it } from "vitest";
import { imageBuildRecordViewSchema, imageBuildStatusResponseSchema } from "./image-builds";

describe("imageBuildRecordViewSchema", () => {
  const validRecord = {
    id: "build-1",
    scope_kind: "repo",
    scope_id: "acme/web",
    provider: "modal",
    status: "ready",
    repositories_fingerprint: "fp-current",
    repository_shas: JSON.stringify([{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }]),
    runtime_version: "60",
    build_duration_seconds: 42,
    error_message: "boom",
    created_at: 1700000000000,
  };

  it("parses a valid image build record", () => {
    expect(imageBuildRecordViewSchema.safeParse(validRecord).success).toBe(true);
  });

  it("parses nullable build duration and error fields", () => {
    expect(
      imageBuildRecordViewSchema.safeParse({
        ...validRecord,
        build_duration_seconds: null,
        error_message: null,
      }).success
    ).toBe(true);
  });

  it("rejects malformed or partial image build records", () => {
    expect(imageBuildRecordViewSchema.safeParse({ ...validRecord, status: "done" }).success).toBe(
      false
    );
    expect(
      imageBuildRecordViewSchema.safeParse({ ...validRecord, scope_id: undefined }).success
    ).toBe(false);
  });
});

describe("imageBuildStatusResponseSchema", () => {
  const validRecord = {
    id: "build-1",
    scope_kind: "repo",
    scope_id: "acme/web",
    provider: "modal",
    status: "ready",
    repositories_fingerprint: "fp-current",
    repository_shas: "[]",
    runtime_version: "60",
    build_duration_seconds: null,
    error_message: null,
    created_at: 1700000000000,
  };

  it("parses the status response contract", () => {
    expect(imageBuildStatusResponseSchema.safeParse({ images: [validRecord] }).success).toBe(true);
  });

  it("requires the images array", () => {
    expect(imageBuildStatusResponseSchema.safeParse({}).success).toBe(false);
  });
});
