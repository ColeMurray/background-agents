import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { SourceControlProvider } from "../source-control";
import type { ArtifactRow, SessionRow } from "./types";
import {
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
    promptingUserId: "user-1",
    promptingAuth: null,
    sessionUrl: "https://app.example.com/session/session-name-1",
    ...overrides,
  };
}

function createTestHarness() {
  const log = createMockLogger();
  const provider = createMockProvider();
  const artifacts: ArtifactRow[] = [];
  let session: SessionRow | null = createSession();

  const repository: PullRequestRepository = {
    getSession: () => session,
    updateSessionBranch: (sessionId, branchName) => {
      if (session && session.id === sessionId) {
        session = { ...session, branch_name: branchName };
      }
    },
    listArtifacts: () => [...artifacts],
    createArtifact: (data) => {
      artifacts.unshift({
        id: data.id,
        type: data.type,
        url: data.url,
        metadata: data.metadata,
        created_at: data.createdAt,
      } as ArtifactRow);
    },
  };

  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository,
    sourceControlProvider: provider,
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
    broadcastArtifactCreated: vi.fn(),
  };

  const service = new SessionPullRequestService(deps);

  return {
    service,
    deps,
    provider,
    artifacts,
    setSession: (next: SessionRow | null) => {
      session = next;
    },
  };
}

describe("SessionPullRequestService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
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
    });

    const result = await harness.service.createPullRequest(createInput());

    expect(result).toEqual({
      kind: "error",
      status: 409,
      error: "A pull request has already been created for this session.",
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
      prNumber: 42,
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
});
