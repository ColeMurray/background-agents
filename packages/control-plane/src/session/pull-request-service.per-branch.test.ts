/**
 * Per-branch pull-request policy: one open PR per head branch. Covers stacked
 * PRs, reuse of the open PR on a repeated call, follow-ups after a merge, and
 * the force-push safety rule. Orchestration, multi-repo targeting, and D1
 * record coverage live in pull-request-service.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { PullRequestSnapshot, SourceControlProvider } from "../source-control";
import { buildSessionRepositories } from "./repository-target";
import type { ArtifactRow, SessionRepositoryRow, SessionRow } from "./types";
import type { ArtifactRepository, CreateArtifactData } from "./artifact-repository";
import {
  PullRequestCreationClaims,
  SessionPullRequestService,
  type CreatePullRequestInput,
  type PullRequestRepository,
  type PullRequestServiceDeps,
} from "./pull-request-service";

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
    session_name: "session-name-1",
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
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createMockProvider() {
  return {
    name: "github",
    generatePushAuth: vi.fn(async () => ({ authType: "app", token: "app-token" as const })),
    getRepository: vi.fn(async (_auth: unknown, config: { owner: string; name: string }) => ({
      owner: config.owner,
      name: config.name,
      fullName: `${config.owner}/${config.name}`,
      defaultBranch: "main",
      isPrivate: true,
      providerRepoId: 123,
    })),
    createPullRequest: vi.fn(async () => ({
      id: 42,
      webUrl: "https://github.com/acme/web/pull/42",
      apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
      lifecycleState: "open" as const,
      isDraft: false,
      sourceBranch: "open-inspect/session-name-1",
      targetBranch: "main",
    })),
    getPullRequest: vi.fn(async (config: { owner: string; name: string; number: number }) => ({
      number: config.number,
      url: `https://github.com/${config.owner}/${config.name}/pull/${config.number}`,
      lifecycleState: "open" as const,
      isDraft: false,
      headBranch: "open-inspect/session-name-1",
      baseBranch: "main",
      repoOwner: config.owner,
      repoName: config.name,
    })),
    buildGitPushSpec: vi.fn((config: { targetBranch: string }) => ({
      remoteUrl: "https://example.invalid/repo.git",
      redactedRemoteUrl: "https://example.invalid/<redacted>.git",
      refspec: `HEAD:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      force: true,
    })),
  } as unknown as SourceControlProvider;
}

function createInput(overrides: Partial<CreatePullRequestInput> = {}): CreatePullRequestInput {
  return {
    title: "Test PR",
    body: "Body text",
    repoOwner: "acme",
    repoName: "web",
    promptingUserId: "user-1",
    promptingAuth: null,
    sessionUrl: "https://app.example.com/session/session-name-1",
    ...overrides,
  };
}

/** A `pr` artifact with modern lifecycle metadata, as creation writes it. */
function prArtifact(overrides: {
  id: string;
  number: number;
  head: string;
  base?: string;
  lifecycleState?: "open" | "closed" | "merged";
  updatedAt?: number;
}): ArtifactRow {
  const lifecycleState = overrides.lifecycleState ?? "open";
  return {
    id: overrides.id,
    type: "pr",
    url: `https://github.com/acme/web/pull/${overrides.number}`,
    metadata: JSON.stringify({
      number: overrides.number,
      state: lifecycleState,
      lifecycleState,
      isDraft: false,
      head: overrides.head,
      base: overrides.base ?? "main",
      repoOwner: "acme",
      repoName: "web",
    }),
    created_at: 1000,
    updated_at: overrides.updatedAt ?? 1000,
  } as ArtifactRow;
}

function prSnapshot(overrides: {
  number: number;
  head: string;
  base?: string;
  lifecycleState?: "open" | "closed" | "merged";
}): PullRequestSnapshot {
  return {
    number: overrides.number,
    url: `https://github.com/acme/web/pull/${overrides.number}`,
    lifecycleState: overrides.lifecycleState ?? "open",
    isDraft: false,
    headBranch: overrides.head,
    baseBranch: overrides.base ?? "main",
    repoOwner: "acme",
    repoName: "web",
  };
}

function createTestHarness() {
  const log = createMockLogger();
  const provider = createMockProvider();
  const artifacts: ArtifactRow[] = [];
  let session: SessionRow | null = createSession();
  let repositoryRows: SessionRepositoryRow[] = [];

  const repository: PullRequestRepository = {
    getSession: () => session,
    getSessionRepositories: () =>
      session?.repo_owner && session.repo_name
        ? buildSessionRepositories(
            { repoOwner: session.repo_owner, repoName: session.repo_name },
            repositoryRows
          )
        : [],
    updateSessionBranch: vi.fn((sessionId: string, branchName: string) => {
      if (session && session.id === sessionId) {
        session = { ...session, branch_name: branchName };
      }
    }),
    updateSessionRepositoryBranch: vi.fn(),
  };
  const artifactRepository = {
    listArtifacts: () => [...artifacts],
    createArtifact: (data: CreateArtifactData) => {
      artifacts.unshift({
        id: data.id,
        type: data.type,
        url: data.url,
        metadata: data.metadata,
        created_at: data.createdAt,
        updated_at: data.createdAt,
      } as ArtifactRow);
    },
    getArtifactById: (id: string) => artifacts.find((artifact) => artifact.id === id) ?? null,
    updateArtifact: (id: string, data: { url: string; metadata: string; updatedAt: number }) => {
      const artifact = artifacts.find((row) => row.id === id);
      if (!artifact) return;
      artifact.url = data.url;
      artifact.metadata = data.metadata;
      artifact.updated_at = data.updatedAt;
    },
  } as unknown as ArtifactRepository;

  const sessionPullRequests = { upsert: vi.fn(async () => ({ applied: true })) };

  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository,
    artifactRepository,
    claims: new PullRequestCreationClaims(),
    sourceControlProvider: provider,
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
    messenger: { broadcast: vi.fn(), sendToSandbox: vi.fn(async () => {}) },
    appName: "Open-Inspect",
    sessionPullRequests,
    resolveScmSettings: vi.fn(async () => ({})),
  };

  return {
    service: new SessionPullRequestService(deps),
    deps,
    provider,
    artifacts,
    sessionPullRequests,
    setSession: (next: SessionRow | null) => {
      session = next;
    },
    setRepositories: (rows: SessionRepositoryRow[]) => {
      repositoryRows = rows;
    },
  };
}

describe("per-branch pull requests", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the resolved head, base, and updated=false on creation", async () => {
    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature-x" })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
      headBranch: "feature-x",
      baseBranch: "main",
      updated: false,
    });
  });

  it("force-pushes and reuses the existing open PR when called again for the same head", async () => {
    harness.artifacts.push(prArtifact({ id: "artifact-pr-1", number: 7, head: "feature-x" }));

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature-x" })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 7,
      prUrl: "https://github.com/acme/web/pull/7",
      state: "open",
      headBranch: "feature-x",
      baseBranch: "main",
      updated: true,
    });
    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      expect.objectContaining({ targetBranch: "feature-x", force: true })
    );
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    expect(harness.artifacts.filter((artifact) => artifact.type === "pr")).toHaveLength(1);
  });

  it("creates a new PR from the same head after the existing one merged, despite stale-open metadata", async () => {
    harness.artifacts.push(
      prArtifact({ id: "artifact-pr-1", number: 7, head: "open-inspect/session-name-1" })
    );
    vi.mocked(harness.provider.getPullRequest).mockResolvedValue(
      prSnapshot({ number: 7, head: "open-inspect/session-name-1", lifecycleState: "merged" })
    );

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toMatchObject({ kind: "created", prNumber: 42, updated: false });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it("creates without a provider read when stored metadata already shows the PR merged", async () => {
    harness.artifacts.push(
      prArtifact({ id: "artifact-pr-1", number: 7, head: "feature-x", lifecycleState: "merged" })
    );

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature-x" })
    );

    expect(result).toMatchObject({ kind: "created", prNumber: 42, updated: false });
    expect(harness.provider.getPullRequest).not.toHaveBeenCalled();
  });

  it("refuses to force-push over a fallback-resolved custom branch holding an open PR", async () => {
    // The stored session branch records the *last pushed* branch (e.g. the
    // top of a stack). A request without an explicit head falls back to it;
    // force-pushing the current checkout over it would destroy that PR.
    harness.setSession(createSession({ branch_name: "feat/stack-top" }));
    harness.artifacts.push(prArtifact({ id: "artifact-pr-1", number: 7, head: "feat/stack-top" }));
    vi.mocked(harness.provider.getPullRequest).mockResolvedValue(
      prSnapshot({ number: 7, head: "feat/stack-top" })
    );

    const result = await harness.service.createPullRequest(createInput());

    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.status).toBe(409);
      expect(result.error).toContain("#7");
      expect(result.error).toContain("feat/stack-top");
    }
    expect(harness.deps.pushBranchToRemote).not.toHaveBeenCalled();
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
  });

  it("updates the session-branch PR on a follow-up call without an explicit head", async () => {
    // The v1 single-PR flow: the agent works on the base branch and the
    // generated session branch carries the PR. A follow-up call must keep
    // updating that PR, not conflict.
    harness.setSession(createSession({ branch_name: "open-inspect/session-name-1" }));
    harness.artifacts.push(
      prArtifact({ id: "artifact-pr-1", number: 7, head: "open-inspect/session-name-1" })
    );

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toMatchObject({
      kind: "created",
      prNumber: 7,
      updated: true,
      headBranch: "open-inspect/session-name-1",
    });
    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      expect.objectContaining({ targetBranch: "open-inspect/session-name-1" })
    );
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
  });

  it("creates a second PR for the same head when an explicit base differs from the existing PR's", async () => {
    harness.artifacts.push(
      prArtifact({ id: "artifact-pr-1", number: 7, head: "feature-x", base: "main" })
    );
    vi.mocked(harness.provider.getPullRequest).mockResolvedValue(
      prSnapshot({ number: 7, head: "feature-x" })
    );

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature-x", baseBranch: "release-1.0" })
    );

    expect(result).toMatchObject({
      kind: "created",
      prNumber: 42,
      updated: false,
      baseBranch: "release-1.0",
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceBranch: "feature-x", targetBranch: "release-1.0" })
    );
  });

  it("reuses the PR from stored metadata when the live provider read fails", async () => {
    harness.artifacts.push(prArtifact({ id: "artifact-pr-1", number: 7, head: "feature-x" }));
    vi.mocked(harness.provider.getPullRequest).mockRejectedValue(new Error("rate limited"));

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature-x" })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 7,
      prUrl: "https://github.com/acme/web/pull/7",
      state: "open",
      headBranch: "feature-x",
      baseBranch: "main",
      updated: true,
    });
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
  });

  it("heals the stale artifact mirror when the live read shows the PR merged", async () => {
    harness.artifacts.push(
      prArtifact({ id: "artifact-pr-1", number: 7, head: "open-inspect/session-name-1" })
    );
    vi.mocked(harness.provider.getPullRequest).mockResolvedValue(
      prSnapshot({ number: 7, head: "open-inspect/session-name-1", lifecycleState: "merged" })
    );

    await harness.service.createPullRequest(createInput());

    const updatedBroadcasts = vi
      .mocked(harness.deps.messenger.broadcast)
      .mock.calls.map(([message]) => message)
      .filter((message) => message.type === "artifact_updated");
    expect(updatedBroadcasts).toHaveLength(1);
    expect(updatedBroadcasts[0]).toMatchObject({
      artifact: expect.objectContaining({
        id: "artifact-pr-1",
        metadata: expect.objectContaining({ lifecycleState: "merged" }),
      }),
    });
    // Authority-then-mirror: the D1 record heals alongside, not just the DO.
    expect(harness.sessionPullRequests.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "artifact-pr-1",
        prNumber: 7,
        lifecycleState: "merged",
      })
    );
  });

  it("creates a second PR when the head branch differs from the existing PR's", async () => {
    harness.artifacts.push(
      prArtifact({ id: "artifact-pr-1", number: 1, head: "open-inspect/session-name-1" })
    );

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature-x" })
    );

    expect(result).toMatchObject({ kind: "created", prNumber: 42 });
    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceBranch: "feature-x", targetBranch: "main" })
    );
    expect(harness.artifacts.filter((artifact) => artifact.type === "pr")).toHaveLength(2);
  });

  describe("multiple candidates on one head", () => {
    it("reuses the base-matching PR, not the most recently updated one", async () => {
      // An explicit base identifies the PR as (head, base): the newer PR on
      // the same head with a different base must not shadow the match.
      harness.artifacts.push(
        prArtifact({
          id: "artifact-pr-1",
          number: 1,
          head: "feature-x",
          base: "main",
          updatedAt: 1000,
        }),
        prArtifact({
          id: "artifact-pr-2",
          number: 2,
          head: "feature-x",
          base: "release",
          updatedAt: 2000,
        })
      );
      vi.mocked(harness.provider.getPullRequest).mockImplementation(
        async (config: { owner: string; name: string; number: number }) => ({
          number: config.number,
          url: `https://github.com/acme/web/pull/${config.number}`,
          lifecycleState: "open" as const,
          isDraft: false,
          headBranch: "feature-x",
          baseBranch: config.number === 2 ? "release" : "main",
          repoOwner: "acme",
          repoName: "web",
        })
      );

      const result = await harness.service.createPullRequest(
        createInput({ headBranch: "feature-x", baseBranch: "main" })
      );

      expect(result).toMatchObject({
        kind: "created",
        prNumber: 1,
        updated: true,
        baseBranch: "main",
      });
      expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    });

    it("reuses an older open PR when the newest candidate turns out closed", async () => {
      harness.artifacts.push(
        prArtifact({ id: "artifact-pr-1", number: 1, head: "feature-x", updatedAt: 1000 }),
        prArtifact({ id: "artifact-pr-2", number: 2, head: "feature-x", updatedAt: 2000 })
      );
      vi.mocked(harness.provider.getPullRequest).mockImplementation(
        async (config: { owner: string; name: string; number: number }) => ({
          number: config.number,
          url: `https://github.com/acme/web/pull/${config.number}`,
          lifecycleState: config.number === 2 ? ("closed" as const) : ("open" as const),
          isDraft: false,
          headBranch: "feature-x",
          baseBranch: "main",
          repoOwner: "acme",
          repoName: "web",
        })
      );

      const result = await harness.service.createPullRequest(
        createInput({ headBranch: "feature-x" })
      );

      expect(result).toMatchObject({ kind: "created", prNumber: 1, updated: true });
      expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
      // The closed candidate's stale-open mirror healed on the way past it.
      const healed = vi
        .mocked(harness.deps.messenger.broadcast)
        .mock.calls.map(([message]) => message)
        .filter((message) => message.type === "artifact_updated");
      expect(healed).toHaveLength(1);
    });
  });

  describe("legacy metadata in multi-repo sessions", () => {
    beforeEach(() => {
      harness.setRepositories([
        {
          position: 0,
          repo_owner: "acme",
          repo_name: "web",
          repo_id: 123,
          base_branch: "main",
          branch_name: null,
          base_sha: null,
          current_sha: null,
        },
        {
          position: 1,
          repo_owner: "acme",
          repo_name: "backend",
          repo_id: 456,
          base_branch: "develop",
          branch_name: null,
          base_sha: null,
          current_sha: null,
        },
      ]);
    });

    it("updates the repo's PR when legacy metadata without a head claims the session branch", async () => {
      harness.artifacts.push({
        id: "artifact-pr-backend",
        type: "pr",
        url: "https://github.com/acme/backend/pull/9",
        metadata: JSON.stringify({ number: 9, repoOwner: "acme", repoName: "backend" }),
        created_at: Date.now(),
        updated_at: Date.now(),
      } as ArtifactRow);

      const result = await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(result).toMatchObject({ kind: "created", prNumber: 9, updated: true });
      expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: "open-inspect/session-name-1" })
      );
      expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    });

    it("treats a PR artifact without repo metadata as the primary's", async () => {
      harness.artifacts.push({
        id: "artifact-pr-legacy",
        type: "pr",
        url: "https://github.com/acme/web/pull/1",
        metadata: JSON.stringify({ number: 1 }),
        created_at: Date.now(),
        updated_at: Date.now(),
      } as ArtifactRow);

      const primaryResult = await harness.service.createPullRequest(createInput());
      expect(primaryResult).toMatchObject({ kind: "created", prNumber: 1, updated: true });
      expect(harness.provider.createPullRequest).not.toHaveBeenCalled();

      const secondaryResult = await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );
      expect(secondaryResult).toMatchObject({ kind: "created", prNumber: 42, updated: false });
      expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    });
  });
});
