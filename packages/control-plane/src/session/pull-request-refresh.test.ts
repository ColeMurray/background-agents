import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestSnapshot } from "../source-control";
import { refreshSessionPullRequests } from "./pull-request-refresh";
import type { ArtifactRow, SessionRow } from "./types";

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-session-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createPrArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/web/pull/7",
    metadata: JSON.stringify({
      number: 7,
      state: "open",
      lifecycleState: "open",
      isDraft: false,
      head: "open-inspect/public-session-1",
      base: "main",
      repoOwner: "acme",
      repoName: "web",
      repositoryExternalId: "9001",
    }),
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function createSnapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    number: 7,
    url: "https://github.com/acme/web/pull/7",
    lifecycleState: "merged",
    isDraft: false,
    headBranch: "open-inspect/public-session-1",
    baseBranch: "main",
    headSha: "abc123",
    repoOwner: "acme",
    repoName: "web",
    repositoryExternalId: "9001",
    providerUpdatedAt: 6000,
    ...overrides,
  };
}

function createHarness(artifacts: ArtifactRow[], session: SessionRow | null = createSession()) {
  const rows = [...artifacts];
  const updateArtifact = vi.fn((artifactId: string, data: { metadata: string | null }) => {
    const index = rows.findIndex((row) => row.id === artifactId);
    if (index >= 0) rows[index] = { ...rows[index], metadata: data.metadata };
  });
  const repository = {
    getSession: vi.fn(() => session),
    listArtifacts: vi.fn(() => [...rows]),
    updateArtifact,
  };
  const getPullRequest = vi.fn(async () => createSnapshot());
  const upsert = vi.fn(async () => ({ applied: true }));

  return {
    repository,
    getPullRequest,
    upsert,
    refresh: () => refreshSessionPullRequests(repository, { getPullRequest }, { upsert }),
  };
}

describe("refreshSessionPullRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes each PR artifact from the provider and repairs the D1 record", async () => {
    const harness = createHarness([createPrArtifact()]);

    const result = await harness.refresh();

    expect(result.failures).toEqual([]);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toMatchObject({
      id: "artifact-1",
      type: "pr",
      metadata: expect.objectContaining({ lifecycleState: "merged" }),
    });
    expect(harness.getPullRequest).toHaveBeenCalledWith({
      owner: "acme",
      name: "web",
      number: 7,
      repositoryExternalId: "9001",
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
      providerUpdatedAt: 6000,
      createdAt: 1000,
      updatedAt: 100_000,
    });
    expect(harness.repository.updateArtifact).toHaveBeenCalledTimes(1);
  });

  it("skips non-PR artifacts and sessions without artifacts", async () => {
    const harness = createHarness([
      createPrArtifact({ id: "branch-1", type: "branch", metadata: null }),
    ]);

    const result = await harness.refresh();

    expect(result).toEqual({ updated: [], failures: [] });
    expect(harness.getPullRequest).not.toHaveBeenCalled();
  });

  it("reports an unchanged provider snapshot as neither updated nor failed", async () => {
    const artifact = createPrArtifact({
      metadata: JSON.stringify({
        number: 7,
        state: "merged",
        lifecycleState: "merged",
        isDraft: false,
        head: "open-inspect/public-session-1",
        base: "main",
        repoOwner: "acme",
        repoName: "web",
        headSha: "abc123",
        repositoryExternalId: "9001",
        providerUpdatedAt: 6000,
      }),
    });
    const harness = createHarness([artifact]);

    const result = await harness.refresh();

    expect(result).toEqual({ updated: [], failures: [] });
    expect(harness.upsert).toHaveBeenCalledTimes(1);
    expect(harness.repository.updateArtifact).not.toHaveBeenCalled();
  });

  it("falls back to the session's primary repo for legacy metadata without identity", async () => {
    const harness = createHarness([createPrArtifact({ metadata: JSON.stringify({ number: 7 }) })]);

    await harness.refresh();

    expect(harness.getPullRequest).toHaveBeenCalledWith({
      owner: "acme",
      name: "web",
      number: 7,
      repositoryExternalId: undefined,
    });
  });

  it("reports artifacts whose metadata carries no PR number as not refreshable", async () => {
    const harness = createHarness([createPrArtifact({ metadata: JSON.stringify({}) })]);

    const result = await harness.refresh();

    expect(result.updated).toEqual([]);
    expect(result.failures).toEqual([{ artifactId: "artifact-1", reason: "not_refreshable" }]);
    expect(harness.getPullRequest).not.toHaveBeenCalled();
  });

  it("continues past a provider read failure and reports it", async () => {
    const harness = createHarness([
      createPrArtifact(),
      createPrArtifact({ id: "artifact-2", metadata: JSON.stringify({ number: 8 }) }),
    ]);
    const providerError = new Error("provider down");
    harness.getPullRequest
      .mockRejectedValueOnce(providerError)
      .mockResolvedValueOnce(createSnapshot({ number: 8 }));

    const result = await harness.refresh();

    expect(result.updated).toHaveLength(1);
    expect(result.updated[0].id).toBe("artifact-2");
    expect(result.failures).toEqual([
      expect.objectContaining({
        artifactId: "artifact-1",
        reason: "provider_read_failed",
        prNumber: 7,
        error: providerError,
      }),
    ]);
  });

  it("treats a D1 upsert failure as non-fatal and still updates the DO artifact", async () => {
    const harness = createHarness([createPrArtifact()]);
    const upsertError = new Error("D1 unavailable");
    harness.upsert.mockRejectedValue(upsertError);

    const result = await harness.refresh();

    expect(result.updated).toHaveLength(1);
    expect(result.failures).toEqual([
      expect.objectContaining({
        artifactId: "artifact-1",
        reason: "record_write_failed",
        error: upsertError,
      }),
    ]);
    expect(harness.repository.updateArtifact).toHaveBeenCalledTimes(1);
  });

  it("does not touch the DO mirror when the D1 monotonic guard rejects the snapshot", async () => {
    const harness = createHarness([createPrArtifact()]);
    harness.upsert.mockResolvedValue({ applied: false });

    const result = await harness.refresh();

    expect(result).toEqual({ updated: [], failures: [] });
    expect(harness.repository.updateArtifact).not.toHaveBeenCalled();
  });

  it("updates the DO mirror without a D1 store", async () => {
    const harness = createHarness([createPrArtifact()]);

    const result = await refreshSessionPullRequests(
      harness.repository,
      { getPullRequest: harness.getPullRequest },
      null
    );

    expect(result.updated).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(harness.repository.updateArtifact).toHaveBeenCalledTimes(1);
  });

  it("no-ops without a session row", async () => {
    const harness = createHarness([createPrArtifact()], null);

    const result = await harness.refresh();

    expect(result).toEqual({ updated: [], failures: [] });
    expect(harness.getPullRequest).not.toHaveBeenCalled();
  });
});
