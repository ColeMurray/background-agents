import { describe, expect, it } from "vitest";
import {
  mergeSnapshotMetadata,
  parsePullRequestArtifactMetadata,
  preparePullRequestArtifactUpdate,
  pullRequestSnapshotSchema,
  snapshotToRecord,
  type PullRequestSnapshotInput,
} from "./pull-request-snapshot";
import type { ArtifactRow } from "./types";

function snapshot(overrides: Partial<PullRequestSnapshotInput> = {}): PullRequestSnapshotInput {
  return {
    number: 123,
    url: "https://github.com/octo/repo/pull/123",
    lifecycleState: "open",
    isDraft: false,
    headBranch: "feature",
    baseBranch: "main",
    headSha: "abc123",
    repoOwner: "octo",
    repoName: "repo",
    repositoryExternalId: "repo-1",
    providerCreatedAt: 900,
    providerUpdatedAt: 1_000,
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/octo/repo/pull/123",
    metadata: JSON.stringify({
      number: 123,
      state: "open",
      lifecycleState: "open",
      isDraft: false,
      head: "feature",
      base: "main",
      headSha: "abc123",
      repoOwner: "octo",
      repoName: "repo",
      repositoryExternalId: "repo-1",
      providerUpdatedAt: 1_000,
    }),
    created_at: 100,
    updated_at: 200,
    ...overrides,
  };
}

describe("parsePullRequestArtifactMetadata", () => {
  it("parses object metadata and preserves unknown fields", () => {
    expect(parsePullRequestArtifactMetadata('{"state":"open","legacy":42}')).toEqual({
      state: "open",
      legacy: 42,
    });
  });

  it("rejects non-object metadata", () => {
    expect(parsePullRequestArtifactMetadata("[]")).toEqual({});
    expect(parsePullRequestArtifactMetadata("null")).toEqual({});
  });

  it("rejects malformed JSON", () => {
    expect(parsePullRequestArtifactMetadata("not json")).toEqual({});
  });
});

describe("pullRequestSnapshotSchema", () => {
  it("rejects draft snapshots once a pull request is no longer open", () => {
    expect(() =>
      pullRequestSnapshotSchema.parse(snapshot({ lifecycleState: "closed", isDraft: true }))
    ).toThrow("isDraft is only valid while the pull request is open");
  });
});

describe("snapshotToRecord", () => {
  it("clears outcome timestamps outside their valid lifecycle states", () => {
    expect(
      snapshotToRecord(snapshot({ lifecycleState: "open", mergedAt: 1_100, closedAt: 1_200 }), {
        artifactId: "artifact-1",
        sessionId: "session-1",
        createdAt: 10,
        updatedAt: 20,
      })
    ).toMatchObject({ mergedAt: null, closedAt: null });

    expect(
      snapshotToRecord(snapshot({ lifecycleState: "closed", mergedAt: 1_100, closedAt: 1_200 }), {
        artifactId: "artifact-1",
        sessionId: "session-1",
        createdAt: 10,
        updatedAt: 20,
      })
    ).toMatchObject({ mergedAt: null, closedAt: 1_200 });

    expect(
      snapshotToRecord(snapshot({ lifecycleState: "merged", mergedAt: 1_100, closedAt: 1_200 }), {
        artifactId: "artifact-1",
        sessionId: "session-1",
        createdAt: 10,
        updatedAt: 20,
      })
    ).toMatchObject({ mergedAt: 1_100, closedAt: 1_200 });
  });
});

describe("mergeSnapshotMetadata", () => {
  it("preserves legacy metadata while updating lifecycle display fields", () => {
    expect(
      mergeSnapshotMetadata(
        { legacy: 42, state: "open", providerUpdatedAt: 900 },
        snapshot({ lifecycleState: "open", isDraft: true, providerUpdatedAt: 1_000 })
      )
    ).toEqual({
      legacy: 42,
      number: 123,
      state: "draft",
      lifecycleState: "open",
      isDraft: true,
      head: "feature",
      base: "main",
      headSha: "abc123",
      repoOwner: "octo",
      repoName: "repo",
      repositoryExternalId: "repo-1",
      providerUpdatedAt: 1_000,
    });
  });
});

describe("preparePullRequestArtifactUpdate", () => {
  it("rejects snapshots older than the stored provider timestamp", () => {
    expect(
      preparePullRequestArtifactUpdate(artifact(), snapshot({ providerUpdatedAt: 999 }), 300)
    ).toBeNull();
  });

  it("accepts changed content at the same provider timestamp", () => {
    const update = preparePullRequestArtifactUpdate(
      artifact(),
      snapshot({ isDraft: true, providerUpdatedAt: 1_000 }),
      300
    );

    expect(update?.artifact.metadata).toMatchObject({ state: "draft", isDraft: true });
  });

  it("accepts snapshots when either provider timestamp is missing", () => {
    expect(
      preparePullRequestArtifactUpdate(
        artifact(),
        snapshot({ isDraft: true, providerUpdatedAt: undefined }),
        300
      )
    ).not.toBeNull();

    expect(
      preparePullRequestArtifactUpdate(
        artifact({ metadata: '{"state":"open"}' }),
        snapshot({ isDraft: true, providerUpdatedAt: 999 }),
        300
      )
    ).not.toBeNull();
  });

  it("returns null when the snapshot does not materially change the artifact", () => {
    expect(preparePullRequestArtifactUpdate(artifact(), snapshot(), 300)).toBeNull();
  });

  it("returns repository update and broadcast payload for accepted lifecycle changes", () => {
    const update = preparePullRequestArtifactUpdate(
      artifact({ metadata: '{"legacy":true,"providerUpdatedAt":1000}' }),
      snapshot({
        url: "https://github.com/octo/renamed/pull/123",
        lifecycleState: "merged",
        repoName: "renamed",
        providerUpdatedAt: 1_100,
      }),
      300
    );

    expect(update?.update).toEqual({
      url: "https://github.com/octo/renamed/pull/123",
      metadata: expect.any(String),
      updatedAt: 300,
    });
    expect(JSON.parse(update?.update.metadata ?? "{}")).toEqual({
      legacy: true,
      providerUpdatedAt: 1_100,
      number: 123,
      state: "merged",
      lifecycleState: "merged",
      isDraft: false,
      head: "feature",
      base: "main",
      headSha: "abc123",
      repoOwner: "octo",
      repoName: "renamed",
      repositoryExternalId: "repo-1",
    });
    expect(update?.artifact).toEqual({
      id: "artifact-1",
      type: "pr",
      url: "https://github.com/octo/renamed/pull/123",
      metadata: {
        legacy: true,
        providerUpdatedAt: 1_100,
        number: 123,
        state: "merged",
        lifecycleState: "merged",
        isDraft: false,
        head: "feature",
        base: "main",
        headSha: "abc123",
        repoOwner: "octo",
        repoName: "renamed",
        repositoryExternalId: "repo-1",
      },
      createdAt: 100,
      updatedAt: 300,
    });
  });
});
