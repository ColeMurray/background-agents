import { describe, expect, it } from "vitest";
import {
  sessionArtifactSchema,
  toDisplayStatus,
  type PullRequestArtifactMetadata,
  type PullRequestStatus,
} from "./artifacts";

describe("toDisplayStatus", () => {
  it("maps merged lifecycle to merged", () => {
    expect(toDisplayStatus({ lifecycleState: "merged", isDraft: false })).toBe("merged");
  });

  it("maps closed lifecycle to closed", () => {
    expect(toDisplayStatus({ lifecycleState: "closed", isDraft: false })).toBe("closed");
  });

  it("maps open + draft to draft", () => {
    expect(toDisplayStatus({ lifecycleState: "open", isDraft: true })).toBe("draft");
  });

  it("maps open + ready to open", () => {
    expect(toDisplayStatus({ lifecycleState: "open", isDraft: false })).toBe("open");
  });

  it("ignores a stray draft flag on terminal states (isDraft is only meaningful while open)", () => {
    // The invariant is enforced at the write boundaries; display must not
    // resurrect "draft" for a PR that already merged or closed.
    expect(toDisplayStatus({ lifecycleState: "merged", isDraft: true })).toBe("merged");
    expect(toDisplayStatus({ lifecycleState: "closed", isDraft: true })).toBe("closed");
  });
});

describe("sessionArtifactSchema.updatedAt", () => {
  const base = {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/7",
    metadata: null,
    createdAt: 1_700_000_000_000,
  };

  it("accepts an artifact without updatedAt (rolling deploy: old producers)", () => {
    const parsed = sessionArtifactSchema.parse(base);
    expect(parsed.updatedAt).toBeUndefined();
  });

  it("accepts an artifact with updatedAt", () => {
    const parsed = sessionArtifactSchema.parse({ ...base, updatedAt: 1_700_000_001_000 });
    expect(parsed.updatedAt).toBe(1_700_000_001_000);
  });

  it("rejects a non-numeric updatedAt", () => {
    expect(sessionArtifactSchema.safeParse({ ...base, updatedAt: "later" }).success).toBe(false);
  });
});

describe("PullRequestArtifactMetadata", () => {
  it("is structurally compatible with the untyped artifact metadata record", () => {
    // The DO stores metadata as Record<string, unknown>; the typed shape must
    // round-trip through that boundary without a cast at write sites.
    const metadata: PullRequestArtifactMetadata = {
      number: 7,
      lifecycleState: "open",
      isDraft: true,
      head: "open-inspect/session-1",
      base: "main",
      headSha: "abc123",
      repoOwner: "acme",
      repoName: "web",
      repositoryExternalId: "9001",
      providerUpdatedAt: 1_700_000_000_000,
    };
    const record: Record<string, unknown> = { ...metadata };
    expect(record.number).toBe(7);

    const status: PullRequestStatus = {
      lifecycleState: metadata.lifecycleState,
      isDraft: metadata.isDraft,
    };
    expect(toDisplayStatus(status)).toBe("draft");
  });
});
