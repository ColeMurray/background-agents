import { describe, expect, it } from "vitest";
import { piRepositoryPinsSchema } from "./session-context-contract";
import {
  piRepositoryMaterializationBatchSchema,
  piRepositoryMaterializationManifestSchema,
  piRepositoryMaterializationRequestSchema,
  piRepositoryMaterializationSchema,
} from "./repository-materialization-contract";

const FULL_SHA = "a".repeat(40);

describe("Pi repository context contracts", () => {
  it("accepts only full immutable repository pins", () => {
    const pin = {
      repoOwner: "acme",
      repoName: "widgets",
      position: 0,
      commitSha: FULL_SHA,
    };

    expect(piRepositoryPinsSchema.safeParse([pin]).success).toBe(true);
    expect(piRepositoryPinsSchema.safeParse([{ ...pin, commitSha: "abc123" }]).success).toBe(false);
  });

  it("accepts a credential-free bounded materialization manifest", () => {
    const result = piRepositoryMaterializationSchema.safeParse({
      version: 1,
      repository: {
        position: 0,
        repoOwner: "acme",
        repoName: "widgets",
        commitSha: FULL_SHA,
        root: "/workspace/repos/0",
      },
      files: [
        {
          path: "src/index.ts",
          blobId: "blob-1",
          mode: "100644",
          sizeBytes: 5,
          contentBase64: "aGVsbG8=",
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(JSON.stringify(result.data)).not.toMatch(/token|credential|authorization/i);
  });

  it("separates one tree manifest from bounded file-content batches", () => {
    const repository = {
      position: 0,
      repoOwner: "acme",
      repoName: "widgets",
      commitSha: FULL_SHA,
      root: "/workspace/repos/0",
    };
    const file = {
      path: "src/index.ts",
      blobId: "blob-1",
      mode: "100644" as const,
      sizeBytes: 5,
    };

    expect(
      piRepositoryMaterializationRequestSchema.safeParse({
        operation: "files",
        repository: 0,
        commitSha: FULL_SHA,
        offset: 40,
      }).success
    ).toBe(true);
    expect(
      piRepositoryMaterializationManifestSchema.safeParse({
        version: 1,
        repository,
        files: [file],
      }).success
    ).toBe(true);
    expect(
      piRepositoryMaterializationBatchSchema.safeParse({
        version: 1,
        repository,
        offset: 0,
        nextOffset: null,
        files: [{ ...file, contentBase64: "aGVsbG8=" }],
      }).success
    ).toBe(true);
  });

  it("rejects unsupported modes and malformed materialized paths", () => {
    const base = {
      version: 1,
      repository: {
        position: 0,
        repoOwner: "acme",
        repoName: "widgets",
        commitSha: FULL_SHA,
        root: "/workspace/repos/0",
      },
      files: [
        {
          path: "../secret",
          blobId: "blob-1",
          mode: "120000",
          sizeBytes: 5,
          contentBase64: "aGVsbG8=",
        },
      ],
    };

    expect(piRepositoryMaterializationSchema.safeParse(base).success).toBe(false);
  });
});
