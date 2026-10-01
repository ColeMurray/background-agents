import { vi } from "vitest";
import type { ScmSettings } from "@open-inspect/shared/types/integrations";
import type { Logger } from "../logger";
import type { CredentialScope, SourceControlProvider } from "../source-control";
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

export function artifactCreatedBroadcasts(deps: PullRequestServiceDeps) {
  return vi
    .mocked(deps.messenger.broadcast)
    .mock.calls.map(([message]) => message)
    .filter((message) => message.type === "artifact_created");
}

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

export function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
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
    agent_session_id: null,
    harness: "opencode",
    model: "anthropic/claude-sonnet-4-5",
    reasoning_effort: null,
    status: "active",
    status_revision: 1,
    parent_session_id: null,
    spawn_source: "user" as const,
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

export function createInput(
  overrides: Partial<CreatePullRequestInput> = {}
): CreatePullRequestInput {
  return {
    title: "Test PR",
    body: "Body text",
    repoOwner: "acme",
    repoName: "web",
    promptingUserId: "user-1",
    resolvePromptingAuth: vi.fn(async () => ({ auth: null })),
    sessionUrl: "https://app.example.com/session/session-name-1",
    ...overrides,
  };
}

export function createRepositoryRow(
  overrides: Partial<SessionRepositoryRow> = {}
): SessionRepositoryRow {
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

export function createTestHarness(options: { scmSettings?: ScmSettings } = {}) {
  const log = createMockLogger();
  const provider = createMockProvider();
  const artifacts: ArtifactRow[] = [];
  let session: SessionRow | null = createSession();
  let repositoryRows: SessionRepositoryRow[] = [];

  const repository: PullRequestRepository = {
    getSession: () => session,
    // Mirrors SessionCoreRepository.getSessionRepositories: members derive from the
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
  const credentialScope: CredentialScope = { kind: "repositories", repositoryIds: [123, 456] };

  let idCounter = 0;
  const deps: PullRequestServiceDeps = {
    repository,
    artifactRepository,
    claims: new PullRequestCreationClaims(),
    sourceControlProvider: provider,
    resolveCredentialScope: vi.fn(async () => credentialScope),
    log,
    generateId: () => `id-${++idCounter}`,
    pushBranchToRemote: vi.fn(async () => ({ success: true as const })),
    messenger: { broadcast: vi.fn(), sendToSandbox: vi.fn(async () => {}) },
    appName: "Open-Inspect",
    sessionPullRequests,
    resolveScmSettings: vi.fn(async () => options.scmSettings ?? {}),
  };

  const service = new SessionPullRequestService(deps);

  return {
    service,
    deps,
    provider,
    credentialScope,
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
