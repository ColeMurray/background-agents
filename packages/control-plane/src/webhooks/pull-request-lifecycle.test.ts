import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAutomationEvent } from "@open-inspect/shared";
import type { SessionPullRequestRecord } from "../db/session-pull-request-store";
import {
  processPullRequestLifecycleEvent,
  type PullRequestLifecycleDeps,
  type SessionArtifactSummary,
} from "./pull-request-lifecycle";

function createEvent(
  overrides: Partial<GitHubAutomationEvent> = {},
  factsOverrides: Partial<NonNullable<GitHubAutomationEvent["pullRequest"]>> | null = {}
): GitHubAutomationEvent {
  return {
    source: "github",
    eventType: "pull_request.closed",
    triggerKey: "pr:7:closed:abc123",
    concurrencyKey: "pr:7",
    contextBlock: "",
    meta: {},
    repoOwner: "acme",
    repoName: "web",
    branch: "open-inspect/public-session-1",
    targetBranch: "main",
    pullRequest:
      factsOverrides === null
        ? undefined
        : {
            number: 7,
            state: "closed",
            merged: true,
            draft: false,
            headSha: "abc123",
            isCrossRepository: false,
            url: "https://github.com/acme/web/pull/7",
            repositoryExternalId: "9001",
            providerUpdatedAt: 5000,
            ...factsOverrides,
          },
    ...overrides,
  };
}

function createRecord(overrides: Partial<SessionPullRequestRecord> = {}): SessionPullRequestRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "public-session-1",
    repositoryExternalId: "9001",
    repoOwner: "acme",
    repoName: "web",
    prNumber: 7,
    url: "https://github.com/acme/web/pull/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: "open-inspect/public-session-1",
    baseBranch: "main",
    headSha: null,
    providerUpdatedAt: 1000,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function createHarness() {
  const getByIdentity = vi.fn(async (): Promise<SessionPullRequestRecord | null> => null);
  const upsert = vi.fn(async () => ({ applied: true }));
  const isRepositoryAssociated = vi.fn(async () => false);
  const getSession = vi.fn(async () => ({
    id: "public-session-1",
    repoOwner: "acme",
    repoName: "web",
  }));
  const listSessionArtifacts = vi.fn(async (): Promise<SessionArtifactSummary[]> => []);
  const pushSnapshotToSession = vi.fn(async () => {});

  const deps: PullRequestLifecycleDeps = {
    store: { getByIdentity, upsert },
    sessions: { isRepositoryAssociated, get: getSession },
    listSessionArtifacts,
    pushSnapshotToSession,
    now: () => 99_000,
  };

  return {
    deps,
    getByIdentity,
    upsert,
    isRepositoryAssociated,
    getSession,
    listSessionArtifacts,
    pushSnapshotToSession,
  };
}

describe("processPullRequestLifecycleEvent", () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it("ignores events without pull request facts", async () => {
    const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent({}, null));

    expect(outcome).toBe("not_pull_request");
    expect(harness.getByIdentity).not.toHaveBeenCalled();
  });

  it("drops cross-repository (fork) heads as not-ours", async () => {
    const outcome = await processPullRequestLifecycleEvent(
      harness.deps,
      createEvent({}, { isCrossRepository: true })
    );

    expect(outcome).toBe("cross_repository");
    expect(harness.getByIdentity).not.toHaveBeenCalled();
  });

  it("skips events whose payload carried no state (read-through repairs)", async () => {
    const outcome = await processPullRequestLifecycleEvent(
      harness.deps,
      createEvent({}, { state: undefined })
    );

    expect(outcome).toBe("no_state");
    expect(harness.getByIdentity).not.toHaveBeenCalled();
  });

  it("updates a correlated record and pushes the snapshot to the owning DO", async () => {
    harness.getByIdentity.mockResolvedValue(createRecord());

    const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

    expect(outcome).toBe("updated");
    expect(harness.getByIdentity).toHaveBeenCalledWith({
      repositoryExternalId: "9001",
      repoOwner: "acme",
      repoName: "web",
      prNumber: 7,
    });
    expect(harness.upsert).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      sessionId: "public-session-1",
      repositoryExternalId: "9001",
      repoOwner: "acme",
      repoName: "web",
      prNumber: 7,
      url: "https://github.com/acme/web/pull/7",
      lifecycleState: "merged",
      isDraft: false,
      headBranch: "open-inspect/public-session-1",
      baseBranch: "main",
      headSha: "abc123",
      providerUpdatedAt: 5000,
      createdAt: 100,
      updatedAt: 99_000,
    });
    expect(harness.pushSnapshotToSession).toHaveBeenCalledWith(
      "public-session-1",
      "artifact-1",
      expect.objectContaining({
        number: 7,
        lifecycleState: "merged",
        isDraft: false,
        providerUpdatedAt: 5000,
      })
    );
  });

  it("suppresses a stale draft flag on a terminal state", async () => {
    harness.getByIdentity.mockResolvedValue(createRecord());

    await processPullRequestLifecycleEvent(
      harness.deps,
      createEvent({}, { state: "closed", merged: false, draft: true })
    );

    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycleState: "closed", isDraft: false })
    );
  });

  it("does not push to the DO when the monotonic guard rejects the write", async () => {
    harness.getByIdentity.mockResolvedValue(createRecord({ providerUpdatedAt: 9000 }));
    harness.upsert.mockResolvedValue({ applied: false });

    const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

    expect(outcome).toBe("stale");
    expect(harness.pushSnapshotToSession).not.toHaveBeenCalled();
  });

  it("preserves stored identity fields the webhook did not carry", async () => {
    harness.getByIdentity.mockResolvedValue(
      createRecord({ headSha: "stored-sha", providerUpdatedAt: 1000 })
    );

    await processPullRequestLifecycleEvent(
      harness.deps,
      createEvent(
        {},
        { headSha: undefined, providerUpdatedAt: undefined, repositoryExternalId: undefined }
      )
    );

    expect(harness.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        headSha: "stored-sha",
        providerUpdatedAt: 1000,
        repositoryExternalId: "9001",
      })
    );
  });

  describe("branch-derived fallback (miss path)", () => {
    it("drops events on non-Open-Inspect branches", async () => {
      const outcome = await processPullRequestLifecycleEvent(
        harness.deps,
        createEvent({ branch: "feature/manual-work" })
      );

      expect(outcome).toBe("no_branch_session");
      expect(harness.isRepositoryAssociated).not.toHaveBeenCalled();
    });

    it("drops events whose derived session is not associated with the repo", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(false);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("session_not_associated");
      expect(harness.isRepositoryAssociated).toHaveBeenCalledWith(
        "public-session-1",
        "acme",
        "web"
      );
      expect(harness.upsert).not.toHaveBeenCalled();
    });

    it("inserts a record for the session's matching PR artifact and pushes the snapshot", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.listSessionArtifacts.mockResolvedValue([
        {
          id: "artifact-repaired",
          type: "pr",
          url: "https://github.com/acme/web/pull/7",
          metadata: { number: 7, repoOwner: "acme", repoName: "web" },
        },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("inserted");
      expect(harness.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactId: "artifact-repaired",
          sessionId: "public-session-1",
          prNumber: 7,
          lifecycleState: "merged",
          repositoryExternalId: "9001",
        })
      );
      expect(harness.pushSnapshotToSession).toHaveBeenCalledWith(
        "public-session-1",
        "artifact-repaired",
        expect.objectContaining({ number: 7, lifecycleState: "merged" })
      );
    });

    it("drops the event when the session has no matching PR artifact", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.listSessionArtifacts.mockResolvedValue([
        { id: "branch-1", type: "branch", url: null, metadata: null },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("no_matching_artifact");
      expect(harness.upsert).not.toHaveBeenCalled();
    });

    it("drops the event when the artifact's PR number differs", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.listSessionArtifacts.mockResolvedValue([
        {
          id: "artifact-other",
          type: "pr",
          url: "https://github.com/acme/web/pull/999",
          metadata: { number: 999, repoOwner: "acme", repoName: "web" },
        },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("no_matching_artifact");
      expect(harness.upsert).not.toHaveBeenCalled();
    });

    it("repairs the numbered artifact even when another same-repo PR artifact sorts first", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.listSessionArtifacts.mockResolvedValue([
        {
          id: "artifact-other",
          type: "pr",
          url: "https://github.com/acme/web/pull/999",
          metadata: { number: 999, repoOwner: "acme", repoName: "web" },
        },
        {
          id: "artifact-match",
          type: "pr",
          url: "https://github.com/acme/web/pull/7",
          metadata: { number: 7, repoOwner: "acme", repoName: "web" },
        },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("inserted");
      expect(harness.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: "artifact-match", prNumber: 7 })
      );
      expect(harness.pushSnapshotToSession).toHaveBeenCalledWith(
        "public-session-1",
        "artifact-match",
        expect.objectContaining({ number: 7 })
      );
    });

    it("prefers the numbered artifact over number-less legacy metadata", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.listSessionArtifacts.mockResolvedValue([
        {
          id: "artifact-legacy",
          type: "pr",
          url: "https://github.com/acme/web/pull/6",
          metadata: { repoOwner: "acme", repoName: "web" },
        },
        {
          id: "artifact-match",
          type: "pr",
          url: "https://github.com/acme/web/pull/7",
          metadata: { number: 7, repoOwner: "acme", repoName: "web" },
        },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("inserted");
      expect(harness.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: "artifact-match" })
      );
    });

    it("does not push to the DO when the monotonic guard rejects the repair", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.upsert.mockResolvedValue({ applied: false });
      harness.listSessionArtifacts.mockResolvedValue([
        {
          id: "artifact-repaired",
          type: "pr",
          url: "https://github.com/acme/web/pull/7",
          metadata: { number: 7, repoOwner: "acme", repoName: "web" },
        },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("stale");
      expect(harness.pushSnapshotToSession).not.toHaveBeenCalled();
    });

    it("matches identity-less legacy artifact metadata via the primary-repo convention", async () => {
      harness.isRepositoryAssociated.mockResolvedValue(true);
      harness.listSessionArtifacts.mockResolvedValue([
        {
          id: "artifact-legacy",
          type: "pr",
          url: "https://github.com/acme/web/pull/7",
          metadata: { number: 7 },
        },
      ]);

      const outcome = await processPullRequestLifecycleEvent(harness.deps, createEvent());

      expect(outcome).toBe("inserted");
      expect(harness.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ artifactId: "artifact-legacy" })
      );
    });
  });
});
