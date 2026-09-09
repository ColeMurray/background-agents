import { describe, expect, it } from "vitest";
import {
  imageBuildRecordViewSchema,
  imageBuildStatusResponseSchema,
  repositoryShaEntrySchema,
} from "./image-builds";

describe("imageBuildRecordViewSchema", () => {
  const validRecord = {
    id: "build-1",
    scopeKind: "repo",
    scopeId: "acme/web",
    provider: "modal",
    status: "ready",
    repositoriesFingerprint: "fp-current",
    repositoryShas: [{ repoOwner: "acme", repoName: "web", baseSha: "abc123" }],
    runtimeVersion: "60",
    buildDurationSeconds: 42,
    errorMessage: "boom",
    createdAt: 1700000000000,
  };

  it("parses a valid image build record", () => {
    expect(imageBuildRecordViewSchema.safeParse(validRecord).success).toBe(true);
  });

  it("parses nullable build duration and error fields", () => {
    expect(
      imageBuildRecordViewSchema.safeParse({
        ...validRecord,
        repositoryShas: null,
        buildDurationSeconds: null,
        errorMessage: null,
      }).success
    ).toBe(true);
  });

  it("rejects malformed or partial image build records", () => {
    expect(imageBuildRecordViewSchema.safeParse({ ...validRecord, status: "done" }).success).toBe(
      false
    );
    expect(
      imageBuildRecordViewSchema.safeParse({ ...validRecord, scopeId: undefined }).success
    ).toBe(false);
  });
});

describe("repositoryShaEntrySchema", () => {
  it("parses structured repository provenance", () => {
    expect(
      repositoryShaEntrySchema.safeParse({
        repoOwner: "acme",
        repoName: "web",
        baseSha: "abc123",
      }).success
    ).toBe(true);
  });

  it.each([
    { repoOwner: "", repoName: "web", baseSha: "abc123" },
    { repoOwner: "acme", repoName: "", baseSha: "abc123" },
    { repoOwner: "acme", repoName: "web", baseSha: "" },
    { repoOwner: "acme", repoName: "web" },
    { repoOwner: "acme", repoName: "web", baseSha: 123 },
  ])("rejects invalid entry shape %#", (entry) => {
    expect(repositoryShaEntrySchema.safeParse(entry).success).toBe(false);
  });
});

describe("imageBuildStatusResponseSchema", () => {
  const validRecord = {
    id: "build-1",
    scopeKind: "repo",
    scopeId: "acme/web",
    provider: "modal",
    status: "ready",
    repositoriesFingerprint: "fp-current",
    repositoryShas: [],
    runtimeVersion: "60",
    buildDurationSeconds: null,
    errorMessage: null,
    createdAt: 1700000000000,
  };

  it("parses the status response contract", () => {
    expect(imageBuildStatusResponseSchema.safeParse({ images: [validRecord] }).success).toBe(true);
  });

  it("requires the images array", () => {
    expect(imageBuildStatusResponseSchema.safeParse({}).success).toBe(false);
  });
});
