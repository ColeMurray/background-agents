import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { PullRequestSnapshot } from "../source-control";
import {
  PULL_REQUEST_REFRESH_MIN_INTERVAL_MS,
  SessionPullRequestRefreshService,
} from "./pull-request-refresh";
import type { ArtifactRow, SessionRow } from "./types";

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

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
  let nowValue = 100_000;
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
  const broadcastArtifactUpdated = vi.fn();
  const log = createMockLogger();

  const service = new SessionPullRequestRefreshService({
    repository,
    sourceControlProvider: { getPullRequest },
    sessionPullRequests: { upsert },
    broadcastArtifactUpdated,
    log,
    now: () => nowValue,
  });

  return {
    service,
    repository,
    getPullRequest,
    upsert,
    broadcastArtifactUpdated,
    log,
    advance: (ms: number) => {
      nowValue += ms;
    },
  };
}

describe("SessionPullRequestRefreshService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes each PR artifact from the provider and repairs the D1 record", async () => {
    const harness = createHarness([createPrArtifact()]);

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 1, skipped: 0 });
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
    expect(harness.broadcastArtifactUpdated).toHaveBeenCalledTimes(1);
  });

  it("skips non-PR artifacts and sessions without artifacts", async () => {
    const harness = createHarness([
      createPrArtifact({ id: "branch-1", type: "branch", metadata: null }),
    ]);

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 0, skipped: 0 });
    expect(harness.getPullRequest).not.toHaveBeenCalled();
  });

  it("rate-limits repeat refreshes per artifact within the minimum interval", async () => {
    const harness = createHarness([createPrArtifact()]);

    await harness.service.refresh();
    const second = await harness.service.refresh();

    expect(second).toEqual({ refreshed: 0, skipped: 1 });
    expect(harness.getPullRequest).toHaveBeenCalledTimes(1);

    harness.advance(PULL_REQUEST_REFRESH_MIN_INTERVAL_MS + 1);
    await harness.service.refresh();
    expect(harness.getPullRequest).toHaveBeenCalledTimes(2);
  });

  it("counts an unchanged provider snapshot as skipped work, not a refresh", async () => {
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

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 0, skipped: 0 });
    expect(harness.upsert).toHaveBeenCalledTimes(1);
    expect(harness.broadcastArtifactUpdated).not.toHaveBeenCalled();
  });

  it("falls back to the session's primary repo for legacy metadata without identity", async () => {
    const harness = createHarness([createPrArtifact({ metadata: JSON.stringify({ number: 7 }) })]);

    await harness.service.refresh();

    expect(harness.getPullRequest).toHaveBeenCalledWith({
      owner: "acme",
      name: "web",
      number: 7,
      repositoryExternalId: undefined,
    });
  });

  it("skips artifacts whose metadata carries no PR number", async () => {
    const harness = createHarness([createPrArtifact({ metadata: JSON.stringify({}) })]);

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 0, skipped: 0 });
    expect(harness.getPullRequest).not.toHaveBeenCalled();
  });

  it("continues past a provider read failure and rate-limits the failed attempt", async () => {
    const harness = createHarness([
      createPrArtifact(),
      createPrArtifact({ id: "artifact-2", metadata: JSON.stringify({ number: 8 }) }),
    ]);
    harness.getPullRequest
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(createSnapshot({ number: 8 }));

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 1, skipped: 0 });
    expect(harness.log.error).toHaveBeenCalledWith(
      "Pull request read-through failed",
      expect.objectContaining({ artifact_id: "artifact-1" })
    );

    // The failed attempt still consumes the rate-limit window.
    const second = await harness.service.refresh();
    expect(second.skipped).toBe(2);
  });

  it("treats a D1 upsert failure as non-fatal and still updates the DO artifact", async () => {
    const harness = createHarness([createPrArtifact()]);
    harness.upsert.mockRejectedValue(new Error("D1 unavailable"));

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 1, skipped: 0 });
    expect(harness.broadcastArtifactUpdated).toHaveBeenCalledTimes(1);
    expect(harness.log.error).toHaveBeenCalledWith(
      "Failed to write session pull request record",
      expect.objectContaining({ artifact_id: "artifact-1" })
    );
  });

  it("no-ops without a session row", async () => {
    const harness = createHarness([createPrArtifact()], null);

    const result = await harness.service.refresh();

    expect(result).toEqual({ refreshed: 0, skipped: 0 });
    expect(harness.getPullRequest).not.toHaveBeenCalled();
  });
});
