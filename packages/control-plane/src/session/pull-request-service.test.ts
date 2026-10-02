import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import type { ArtifactRepository, CreateArtifactData } from "./artifact-repository";
import {
  PullRequestCreationClaims,
  SessionPullRequestService,
  type CreatePullRequestInput,
  type PullRequestServiceDeps,
  type PushBranchResult,
} from "./pull-request-service";
import { buildSessionRepositories, type RepoIdentity } from "./repository-target";
import type { ArtifactRow, SessionRepositoryRow, SessionRow } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createInput(overrides: Partial<CreatePullRequestInput> = {}): CreatePullRequestInput {
  return {
    title: "Test PR",
    body: "Body text",
    repoOwner: "acme",
    repoName: "web",
    promptingUserId: "user-1",
    resolvePromptingAuth: async () => ({ auth: null }),
    sessionUrl: "https://app.example.com/session/session-name-1",
    ...overrides,
  };
}

function createTestHarness(
  repositories: RepoIdentity[] = [{ repoOwner: "acme", repoName: "web" }]
) {
  const session: SessionRow = {
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
    agent_session_id: null,
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    status_revision: 1,
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    max_cost_usd: null,
    budget_exhausted: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
  };
  const repositoryRows: SessionRepositoryRow[] = repositories.map((repo, position) => ({
    position,
    repo_owner: repo.repoOwner,
    repo_name: repo.repoName,
    repo_id: 123 + position,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
  }));
  const provider = {
    name: "github" as const,
    generatePushAuth: vi.fn<SourceControlProvider["generatePushAuth"]>(async () => ({
      authType: "app",
      token: "app-token",
    })),
    getRepository: vi.fn<SourceControlProvider["getRepository"]>(async (_auth, repo) => ({
      ...repo,
      fullName: `${repo.owner}/${repo.name}`,
      defaultBranch: "main",
      isPrivate: true,
      providerRepoId: `${repo.owner}/${repo.name}`,
    })),
    buildGitPushSpec: vi.fn<SourceControlProvider["buildGitPushSpec"]>((config) => ({
      remoteUrl: "https://example.invalid/repo.git",
      redactedRemoteUrl: "https://example.invalid/repo.git",
      refspec: `${config.sourceRef}:refs/heads/${config.targetBranch}`,
      targetBranch: config.targetBranch,
      repoOwner: config.owner,
      repoName: config.name,
      force: config.force ?? false,
    })),
    createPullRequest: vi.fn<SourceControlProvider["createPullRequest"]>(async (_auth, config) => ({
      id: 42,
      webUrl: `https://github.com/${config.repository.fullName}/pull/42`,
      apiUrl: `https://api.github.com/repos/${config.repository.fullName}/pulls/42`,
      lifecycleState: "open",
      isDraft: config.draft ?? false,
      sourceBranch: config.sourceBranch,
      targetBranch: config.targetBranch,
    })),
  };
  const artifacts: ArtifactRow[] = [];
  const artifactRepository = {
    listArtifacts: () => [...artifacts],
    createArtifact: (data: CreateArtifactData) => {
      artifacts.push({
        id: data.id,
        type: data.type,
        url: data.url,
        metadata: data.metadata,
        created_at: data.createdAt,
        updated_at: data.createdAt,
      });
    },
  } as unknown as ArtifactRepository;
  const log: Logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => log,
  };
  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository: {
      getSession: () => session,
      getSessionRepositories: () =>
        buildSessionRepositories({ repoOwner: "acme", repoName: "web" }, repositoryRows),
      updateSessionBranch: (_sessionId, branchName) => {
        session.branch_name = branchName;
      },
      updateSessionRepositoryBranch: (repoOwner, repoName, branchName) => {
        const row = repositoryRows.find(
          (repo) => repo.repo_owner === repoOwner && repo.repo_name === repoName
        );
        if (row) row.branch_name = branchName;
      },
    },
    artifactRepository,
    claims: new PullRequestCreationClaims(),
    sourceControlProvider: provider as unknown as SourceControlProvider,
    resolveCredentialScope: async () => ({
      kind: "repositories",
      repositoryIds: repositoryRows.map((row) => row.repo_id!),
    }),
    resolveScmSettings: async () => ({}),
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn<PullRequestServiceDeps["pushBranchToRemote"]>(async () => ({
      success: true,
    })),
    messenger: { broadcast: vi.fn(), sendToSandbox: async () => {} },
    appName: "Open-Inspect",
    sessionPullRequests: { upsert: vi.fn(async () => ({ applied: true })) },
  };

  return {
    deps,
    provider,
    artifacts,
    // Requests get separate service instances but share the DO-scoped claims.
    createPullRequest: (input = createInput()) =>
      new SessionPullRequestService(deps).createPullRequest(input),
  };
}

describe("SessionPullRequestService in-flight creation claims", () => {
  it("rejects same-repo requests while the first creation is awaiting push", async () => {
    const harness = createTestHarness();
    const push = vi.mocked(harness.deps.pushBranchToRemote);
    const gate = deferred<PushBranchResult>();
    push.mockReturnValueOnce(gate.promise);

    const first = harness.createPullRequest();
    try {
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(1));

      const conflict = {
        kind: "error",
        status: 409,
        error: "A pull request is already being created for acme/web in this session.",
      };
      expect(
        await harness.createPullRequest(
          createInput({ repoOwner: "ACME", repoName: "WEB", headBranch: "another-head" })
        )
      ).toEqual(conflict);
      // A rejected request must not release the first request's claim.
      expect(await harness.createPullRequest()).toEqual(conflict);
      expect(push).toHaveBeenCalledTimes(1);
      expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
      expect(harness.artifacts).toHaveLength(0);
    } finally {
      gate.resolve({ success: true });
    }

    expect(await first).toMatchObject({ kind: "created", updated: false });
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    expect(harness.artifacts).toHaveLength(1);
  });

  it("releases the claim after push failure so a new request can retry", async () => {
    const harness = createTestHarness();
    const push = vi.mocked(harness.deps.pushBranchToRemote);
    push.mockResolvedValueOnce({ success: false, error: "Failed to push branch: boom" });

    expect(await harness.createPullRequest()).toEqual({
      kind: "error",
      status: 500,
      error: "Failed to push branch: boom",
    });
    expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    expect(harness.artifacts).toHaveLength(0);

    expect(await harness.createPullRequest()).toMatchObject({ kind: "created", updated: false });
    expect(push).toHaveBeenCalledTimes(2);
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(1);
    expect(harness.artifacts).toHaveLength(1);
  });

  it("allows concurrent repositories sharing an owner or a name", async () => {
    const repositories = [
      { repoOwner: "acme", repoName: "web" },
      { repoOwner: "acme", repoName: "backend" },
      { repoOwner: "other", repoName: "web" },
    ];
    const harness = createTestHarness(repositories);
    const push = vi.mocked(harness.deps.pushBranchToRemote);
    const gate = deferred<PushBranchResult>();
    push.mockReturnValue(gate.promise);

    const requests = repositories.map((repo) => harness.createPullRequest(createInput(repo)));
    try {
      await vi.waitFor(() => expect(push).toHaveBeenCalledTimes(repositories.length));
      for (const repo of repositories) {
        expect(push).toHaveBeenCalledWith(expect.objectContaining(repo));
      }
      expect(harness.provider.createPullRequest).not.toHaveBeenCalled();
    } finally {
      gate.resolve({ success: true });
    }

    const results = await Promise.all(requests);
    expect(results).toEqual(
      repositories.map(() => expect.objectContaining({ kind: "created", updated: false }))
    );
    expect(harness.provider.createPullRequest).toHaveBeenCalledTimes(repositories.length);
    expect(harness.artifacts).toHaveLength(repositories.length);
  });
});
