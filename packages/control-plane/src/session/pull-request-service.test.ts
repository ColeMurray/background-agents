import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import * as branchResolution from "../source-control/branch-resolution";
import type { SessionRepositoryRow } from "./repository";
import { buildSessionRepositories } from "./repository-target";
import type { ArtifactRow, SessionRow } from "./types";
import {
  PullRequestCreationClaims,
  SessionPullRequestService,
  type CreatePullRequestInput,
  type PullRequestRepository,
  type PullRequestServiceDeps,
  type PushBranchResult,
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
    checkRepositoryAccess: vi.fn(),
    listRepositories: vi.fn(),
    generatePushAuth: vi.fn(async () => ({ authType: "app", token: "app-token" as const })),
    getRepository: vi.fn(async () => ({
      owner: "acme",
      name: "web",
      fullName: "acme/web",
      defaultBranch: "main",
      isPrivate: true,
      providerRepoId: 123,
    })),
    createPullRequest: vi.fn(async () => ({
      id: 42,
      webUrl: "https://github.com/acme/web/pull/42",
      apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
      state: "open" as const,
      lifecycleState: "open" as const,
      isDraft: false,
      sourceBranch: "open-inspect/session-name-1",
      targetBranch: "main",
    })),
    buildManualPullRequestUrl: vi.fn(
      (config: { sourceBranch: string; targetBranch: string }) =>
        `https://github.com/acme/web/pull/new/${config.targetBranch}...${config.sourceBranch}`
    ),
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

function createRepositoryRow(overrides: Partial<SessionRepositoryRow> = {}): SessionRepositoryRow {
  return {
    position: 0,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    ...overrides,
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
    // Mirrors SessionRepository.getSessionRepositories: members derive from the
    // session scalars plus whatever rows the test seeds.
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
    updateSessionRepositoryBranch: vi.fn(
      (repoOwner: string, repoName: string, branchName: string) => {
        repositoryRows = repositoryRows.map((row) =>
          row.repo_owner === repoOwner && row.repo_name === repoName
            ? { ...row, branch_name: branchName }
            : row
        );
      }
    ),
    listArtifacts: () => [...artifacts],
    createArtifact: (data) => {
      artifacts.unshift({
        id: data.id,
        type: data.type,
        url: data.url,
        metadata: data.metadata,
        created_at: data.createdAt,
        updated_at: data.createdAt,
      } as ArtifactRow);
    },
  };

  const sessionPullRequests = { upsert: vi.fn(async () => ({ applied: true })) };

  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository,
    claims: new PullRequestCreationClaims(),
    sourceControlProvider: provider,
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
    broadcastSessionBranch: vi.fn(),
    broadcastArtifactCreated: vi.fn(),
    appName: "Open-Inspect",
    sessionPullRequests,
  };

  const service = new SessionPullRequestService(deps);

  return {
    service,
    deps,
    provider,
    artifacts,
    sessionPullRequests,
    log,
    setSession: (next: SessionRow | null) => {
      session = next;
    },
    setRepositories: (rows: SessionRepositoryRow[]) => {
      repositoryRows = rows;
    },
  };
}

describe("SessionPullRequestService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 when session is missing", async () => {
    harness.setSession(null);

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({ kind: "error", status: 404, error: "Session not found" });
  });

  it("returns 409 when PR artifact already exists", async () => {
    harness.artifacts.push({
      id: "artifact-pr-existing",
      type: "pr",
      url: "https://github.com/acme/web/pull/1",
      metadata: null,
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "error",
      status: 409,
      error: "A pull request has already been created for acme/web in this session.",
    });
    expect(harness.provider.generatePushAuth).not.toHaveBeenCalled();
  });

  it("returns 500 when push to remote fails", async () => {
    harness.deps.pushBranchToRemote = vi.fn(async () => ({
      success: false as const,
      error: "Failed to push branch: timeout",
    }));
    harness.service = new SessionPullRequestService(harness.deps);

    const result = await harness.service.createPullRequest(
      createInput({ promptingAuth: { authType: "oauth", token: "user-token" } })
    );

    expect(result).toEqual({
      kind: "error",
      status: 500,
      error: "Failed to push branch: timeout",
    });
    expect(harness.deps.broadcastSessionBranch).not.toHaveBeenCalled();
  });

  it("creates PR with app auth when prompting auth is unavailable", async () => {
    const result = await harness.service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "app", token: "app-token" });
    expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledTimes(1);
    expect(harness.deps.repository.updateSessionBranch).toHaveBeenCalledWith(
      "session-1",
      "open-inspect/session-name-1"
    );
    expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith(
      "open-inspect/session-name-1",
      { repoOwner: "acme", repoName: "web" }
    );
  });

  it("uses the sanitized branch for push, PR creation, and branch sync", async () => {
    const result = await harness.service.createPullRequest(
      createInput({ headBranch: " Feature/Test " })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.provider.buildGitPushSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: "feature/test",
      })
    );
    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: "feature/test",
        refspec: "HEAD:refs/heads/feature/test",
      })
    );
    expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        sourceBranch: "feature/test",
      })
    );
    expect(harness.deps.repository.updateSessionBranch).toHaveBeenCalledWith(
      "session-1",
      "feature/test"
    );
    expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith("feature/test", {
      repoOwner: "acme",
      repoName: "web",
    });
  });

  it("creates PR with OAuth token and stores PR artifact", async () => {
    const result = await harness.service.createPullRequest(
      createInput({ promptingAuth: { authType: "oauth", token: "user-token" } })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[0]).toEqual({ authType: "oauth", token: "user-token" });
    expect(createPrCall[1].body).toContain(
      "*Created with [Open-Inspect](https://app.example.com/session/session-name-1)*"
    );
    expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith({
      id: "id-1",
      type: "pr",
      url: "https://github.com/acme/web/pull/42",
      metadata: {
        number: 42,
        state: "open",
        lifecycleState: "open",
        isDraft: false,
        head: "open-inspect/session-name-1",
        base: "main",
        repoOwner: "acme",
        repoName: "web",
      },
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
  });

  it("uses the configured appName in the PR body footer", async () => {
    const customDeps = { ...harness.deps, appName: "Acme Bot" };
    const customService = new SessionPullRequestService(customDeps);

    await customService.createPullRequest(
      createInput({ promptingAuth: { authType: "oauth", token: "user-token" } })
    );

    const createPrCall = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(createPrCall[1].body).toContain(
      "*Created with [Acme Bot](https://app.example.com/session/session-name-1)*"
    );
    expect(createPrCall[1].body).not.toContain("Open-Inspect");
  });

  it("syncs the branch after push and before PR creation", async () => {
    await harness.service.createPullRequest(createInput());

    const pushOrder = vi.mocked(harness.deps.pushBranchToRemote).mock.invocationCallOrder[0];
    const syncOrder = vi.mocked(harness.deps.broadcastSessionBranch).mock.invocationCallOrder[0];
    const createPrOrder = (harness.provider.createPullRequest as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];

    expect(pushOrder).toBeLessThan(syncOrder);
    expect(syncOrder).toBeLessThan(createPrOrder);
  });

  it("returns 400 when the resolved branch name is invalid after sanitization", async () => {
    vi.spyOn(branchResolution, "resolveHeadBranchForPr").mockReturnValue({
      headBranch: "feature invalid",
      source: "request",
    });

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: "feature invalid" })
    );

    expect(result).toEqual({
      kind: "error",
      status: 400,
      error: "headBranch must be a valid branch name",
    });
    expect(harness.provider.buildGitPushSpec).not.toHaveBeenCalled();
    expect(harness.deps.pushBranchToRemote).not.toHaveBeenCalled();
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    expect(harness.deps.broadcastSessionBranch).not.toHaveBeenCalled();
  });

  it("skips branch writes when the sanitized branch is unchanged but still broadcasts", async () => {
    harness.setSession(createSession({ branch_name: "feature/test" }));

    const result = await harness.service.createPullRequest(
      createInput({ headBranch: " Feature/Test " })
    );

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.deps.repository.updateSessionBranch).not.toHaveBeenCalled();
    expect(harness.provider.buildGitPushSpec).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: "feature/test",
      })
    );
    expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        targetBranch: "feature/test",
        refspec: "HEAD:refs/heads/feature/test",
      })
    );
    expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith("feature/test", {
      repoOwner: "acme",
      repoName: "web",
    });
  });

  describe("multi-repo sessions", () => {
    beforeEach(() => {
      harness.setRepositories([
        createRepositoryRow({ position: 0, repo_owner: "acme", repo_name: "web" }),
        createRepositoryRow({
          position: 1,
          repo_owner: "acme",
          repo_name: "backend",
          repo_id: 456,
          base_branch: "develop",
        }),
      ]);
    });

    it("creates a PR for a secondary member when the primary already has one", async () => {
      harness.artifacts.push({
        id: "artifact-pr-web",
        type: "pr",
        url: "https://github.com/acme/web/pull/1",
        metadata: JSON.stringify({ number: 1, repoOwner: "acme", repoName: "web" }),
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const result = await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(result.kind).toBe("created");
      expect(harness.provider.getRepository).toHaveBeenCalledWith(expect.anything(), {
        owner: "acme",
        name: "backend",
      });
      expect(harness.provider.buildGitPushSpec).toHaveBeenCalledWith(
        expect.objectContaining({ owner: "acme", name: "backend" })
      );
    });

    it("returns 409 for a repo that already has a PR, naming the repo", async () => {
      harness.artifacts.push({
        id: "artifact-pr-backend",
        type: "pr",
        url: "https://github.com/acme/backend/pull/9",
        metadata: JSON.stringify({ number: 9, repoOwner: "acme", repoName: "backend" }),
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const result = await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(result).toEqual({
        kind: "error",
        status: 409,
        error: "A pull request has already been created for acme/backend in this session.",
      });
      expect(harness.provider.generatePushAuth).not.toHaveBeenCalled();
    });

    it("treats a PR artifact without repo metadata as the primary's", async () => {
      harness.artifacts.push({
        id: "artifact-pr-legacy",
        type: "pr",
        url: "https://github.com/acme/web/pull/1",
        metadata: JSON.stringify({ number: 1 }),
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const primaryResult = await harness.service.createPullRequest(createInput());
      expect(primaryResult).toEqual({
        kind: "error",
        status: 409,
        error: "A pull request has already been created for acme/web in this session.",
      });

      const secondaryResult = await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );
      expect(secondaryResult.kind).toBe("created");
    });

    it("defaults the base branch to the target member's base branch", async () => {
      await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(harness.provider.createPullRequest).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ targetBranch: "develop" })
      );
    });

    it("resolves the head branch from the target member's stored branch", async () => {
      harness.setRepositories([
        createRepositoryRow({ position: 0 }),
        createRepositoryRow({
          position: 1,
          repo_owner: "acme",
          repo_name: "backend",
          base_branch: "develop",
          branch_name: "feat/backend-work",
        }),
      ]);

      await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(harness.deps.pushBranchToRemote).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: "feat/backend-work" })
      );
    });

    it("writes the member row without touching the scalar mirror for a secondary", async () => {
      const result = await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(result.kind).toBe("created");
      expect(harness.deps.repository.updateSessionRepositoryBranch).toHaveBeenCalledWith(
        "acme",
        "backend",
        "open-inspect/session-name-1"
      );
      expect(harness.deps.repository.updateSessionBranch).not.toHaveBeenCalled();
      expect(harness.deps.broadcastSessionBranch).toHaveBeenCalledWith(
        "open-inspect/session-name-1",
        { repoOwner: "acme", repoName: "backend" }
      );
    });

    it("writes both the member row and the scalar mirror for the primary", async () => {
      const result = await harness.service.createPullRequest(createInput());

      expect(result.kind).toBe("created");
      expect(harness.deps.repository.updateSessionRepositoryBranch).toHaveBeenCalledWith(
        "acme",
        "web",
        "open-inspect/session-name-1"
      );
      expect(harness.deps.repository.updateSessionBranch).toHaveBeenCalledWith(
        "session-1",
        "open-inspect/session-name-1"
      );
    });

    it("stamps the target repo into the PR artifact metadata", async () => {
      await harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );

      expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ repoOwner: "acme", repoName: "backend" }),
        })
      );
    });

    it("returns 403 when the target is neither a member nor the scalar repo", async () => {
      harness.setRepositories([]);

      const result = await harness.service.createPullRequest(
        createInput({ repoOwner: "evil", repoName: "exfil" })
      );

      expect(result).toEqual({
        kind: "error",
        status: 403,
        error: "Repository evil/exfil is not part of this session",
      });
      expect(harness.provider.generatePushAuth).not.toHaveBeenCalled();
    });
  });

  describe("in-flight creation claims", () => {
    it("rejects a concurrent request for the same repo with 409", async () => {
      let releasePush: (() => void) | undefined;
      harness.deps.pushBranchToRemote = vi.fn(
        () =>
          new Promise<PushBranchResult>((resolve) => {
            releasePush = () => resolve({ success: true });
          })
      );
      harness.service = new SessionPullRequestService(harness.deps);

      const first = harness.service.createPullRequest(createInput());
      await vi.waitFor(() => expect(releasePush).toBeDefined());

      const second = await harness.service.createPullRequest(createInput());
      expect(second).toEqual({
        kind: "error",
        status: 409,
        error: "A pull request is already being created for acme/web in this session.",
      });

      releasePush!();
      expect((await first).kind).toBe("created");
    });

    it("releases the claim when creation fails, allowing a retry", async () => {
      harness.deps.pushBranchToRemote = vi
        .fn<(pushSpec: unknown) => Promise<PushBranchResult>>()
        .mockResolvedValueOnce({ success: false, error: "Failed to push branch: boom" })
        .mockResolvedValue({ success: true });
      harness.service = new SessionPullRequestService(harness.deps);

      const failed = await harness.service.createPullRequest(createInput());
      expect(failed).toEqual({
        kind: "error",
        status: 500,
        error: "Failed to push branch: boom",
      });

      const retried = await harness.service.createPullRequest(createInput());
      expect(retried.kind).toBe("created");
    });

    it("allows concurrent creation for different repos", async () => {
      harness.setRepositories([
        createRepositoryRow({ position: 0 }),
        createRepositoryRow({
          position: 1,
          repo_owner: "acme",
          repo_name: "backend",
          repo_id: 456,
          base_branch: "develop",
        }),
      ]);
      const resolvers: Array<() => void> = [];
      harness.deps.pushBranchToRemote = vi.fn(
        () =>
          new Promise<PushBranchResult>((resolve) => {
            resolvers.push(() => resolve({ success: true }));
          })
      );
      harness.service = new SessionPullRequestService(harness.deps);

      const first = harness.service.createPullRequest(createInput());
      const second = harness.service.createPullRequest(
        createInput({ repoOwner: "acme", repoName: "backend" })
      );
      await vi.waitFor(() => expect(resolvers).toHaveLength(2));
      resolvers.forEach((resolve) => resolve());

      expect((await first).kind).toBe("created");
      expect((await second).kind).toBe("created");
    });
  });

  it("ignores prior manual branch artifact and creates PR", async () => {
    harness.artifacts.push({
      id: "branch-artifact-1",
      type: "branch",
      url: "https://github.com/acme/web/pull/new/main...open-inspect/session-name-1",
      metadata: JSON.stringify({
        mode: "manual_pr",
        head: "open-inspect/session-name-1",
        createPrUrl: "https://existing.example.com/manual-pr",
      }),
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const result = await harness.service.createPullRequest(createInput({ promptingAuth: null }));

    expect(result).toEqual({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/web/pull/42",
      state: "open",
    });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
  });

  describe("session pull request record (D1 authority)", () => {
    it("writes the D1 record after the artifact and before the broadcast", async () => {
      const result = await harness.service.createPullRequest(createInput());

      expect(result.kind).toBe("created");
      expect(harness.sessionPullRequests.upsert).toHaveBeenCalledTimes(1);
      expect(harness.sessionPullRequests.upsert).toHaveBeenCalledWith({
        artifactId: "id-1",
        sessionId: "session-name-1",
        repositoryExternalId: null,
        repoOwner: "acme",
        repoName: "web",
        prNumber: 42,
        url: "https://github.com/acme/web/pull/42",
        lifecycleState: "open",
        isDraft: false,
        headBranch: "open-inspect/session-name-1",
        baseBranch: "main",
        headSha: null,
        providerUpdatedAt: null,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
      });

      const upsertOrder = harness.sessionPullRequests.upsert.mock.invocationCallOrder[0];
      const broadcastOrder = vi.mocked(harness.deps.broadcastArtifactCreated).mock
        .invocationCallOrder[0];
      expect(upsertOrder).toBeLessThan(broadcastOrder);
    });

    it("captures headSha and repositoryExternalId when the provider returns them", async () => {
      vi.mocked(harness.provider.createPullRequest).mockResolvedValue({
        id: 42,
        webUrl: "https://github.com/acme/web/pull/42",
        apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
        state: "open",
        lifecycleState: "open",
        isDraft: false,
        sourceBranch: "open-inspect/session-name-1",
        targetBranch: "main",
        headSha: "abc123",
        repositoryExternalId: "999",
      });

      await harness.service.createPullRequest(createInput());

      expect(harness.sessionPullRequests.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          headSha: "abc123",
          repositoryExternalId: "999",
        })
      );
      expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            headSha: "abc123",
            repositoryExternalId: "999",
          }),
        })
      );
    });

    it("seeds the monotonic guard with the provider's updated_at from creation", async () => {
      vi.mocked(harness.provider.createPullRequest).mockResolvedValue({
        id: 42,
        webUrl: "https://github.com/acme/web/pull/42",
        apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
        state: "open",
        lifecycleState: "open",
        isDraft: false,
        sourceBranch: "open-inspect/session-name-1",
        targetBranch: "main",
        providerUpdatedAt: 1_720_000_000_000,
      });

      await harness.service.createPullRequest(createInput());

      // A first webhook that raced ahead of this write can no longer be
      // regressed by a timestamp-less (guard-authoritative) creation record.
      expect(harness.sessionPullRequests.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ providerUpdatedAt: 1_720_000_000_000 })
      );
      expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ providerUpdatedAt: 1_720_000_000_000 }),
        })
      );
    });

    it("stores the provider's status facts for a draft creation, keeping the display state", async () => {
      vi.mocked(harness.provider.createPullRequest).mockResolvedValue({
        id: 42,
        webUrl: "https://github.com/acme/web/pull/42",
        apiUrl: "https://api.github.com/repos/acme/web/pulls/42",
        state: "draft",
        lifecycleState: "open",
        isDraft: true,
        sourceBranch: "open-inspect/session-name-1",
        targetBranch: "main",
      });

      await harness.service.createPullRequest(createInput());

      expect(harness.sessionPullRequests.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycleState: "open", isDraft: true })
      );
      expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            lifecycleState: "open",
            isDraft: true,
            state: "draft",
          }),
        })
      );
    });

    it("treats a D1 write failure as non-fatal", async () => {
      harness.sessionPullRequests.upsert.mockRejectedValue(new Error("D1 unavailable"));

      const result = await harness.service.createPullRequest(createInput());

      expect(result).toEqual({
        kind: "created",
        prNumber: 42,
        prUrl: "https://github.com/acme/web/pull/42",
        state: "open",
      });
      expect(harness.deps.broadcastArtifactCreated).toHaveBeenCalledTimes(1);
      expect(harness.log.error).toHaveBeenCalledWith(
        "Failed to write session pull request record",
        expect.objectContaining({ artifact_id: "id-1", pr_number: 42 })
      );
    });

    it("skips the D1 write when no store is configured", async () => {
      const deps = { ...harness.deps };
      delete deps.sessionPullRequests;
      const service = new SessionPullRequestService(deps);

      const result = await service.createPullRequest(createInput());

      expect(result.kind).toBe("created");
      expect(harness.sessionPullRequests.upsert).not.toHaveBeenCalled();
    });
  });
});
