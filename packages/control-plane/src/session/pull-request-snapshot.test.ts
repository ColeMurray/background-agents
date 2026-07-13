import { describe, expect, it } from "vitest";
import { snapshotToRecord, type PullRequestSnapshotInput } from "./pull-request-snapshot";

const identity = {
  artifactId: "artifact-1",
  sessionId: "session-1",
  createdAt: 100,
  updatedAt: 200,
};

function makeSnapshot(overrides: Partial<PullRequestSnapshotInput> = {}): PullRequestSnapshotInput {
  return {
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: "open-inspect/session-1",
    baseBranch: "main",
    repoOwner: "acme",
    repoName: "web",
    ...overrides,
  };
}

describe("snapshotToRecord outcome timestamps", () => {
  it("maps provider timestamps through for a merged snapshot", () => {
    const record = snapshotToRecord(
      makeSnapshot({
        lifecycleState: "merged",
        providerCreatedAt: 1_000,
        mergedAt: 5_000,
        closedAt: 5_000,
      }),
      identity
    );

    expect(record.providerCreatedAt).toBe(1_000);
    expect(record.mergedAt).toBe(5_000);
    expect(record.closedAt).toBe(5_000);
  });

  it("keeps closedAt but not mergedAt for a closed-unmerged snapshot", () => {
    const record = snapshotToRecord(
      makeSnapshot({ lifecycleState: "closed", mergedAt: 5_000, closedAt: 5_000 }),
      identity
    );

    expect(record.mergedAt).toBeNull();
    expect(record.closedAt).toBe(5_000);
  });

  it("clears both outcome timestamps while the PR is open (reopen)", () => {
    // The state-scoped rule mirrors draft-only-while-open: a reopened PR has
    // no outcome yet, whatever stale values the snapshot still carries.
    const record = snapshotToRecord(
      makeSnapshot({ lifecycleState: "open", mergedAt: 5_000, closedAt: 5_000 }),
      identity
    );

    expect(record.mergedAt).toBeNull();
    expect(record.closedAt).toBeNull();
  });

  it("stores null when the provider carried no timestamps", () => {
    const record = snapshotToRecord(makeSnapshot({ lifecycleState: "merged" }), identity);

    expect(record.providerCreatedAt).toBeNull();
    expect(record.mergedAt).toBeNull();
    expect(record.closedAt).toBeNull();
  });
});
