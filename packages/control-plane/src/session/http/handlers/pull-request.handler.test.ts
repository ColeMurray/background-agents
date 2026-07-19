import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { SessionRepositoryRow } from "../../repository";
import { buildSessionRepositories, type SessionRepositoryEntry } from "../../repository-target";
import type { ArtifactRow, ParticipantRow, SessionRow } from "../../types";
import { createPullRequestHandler } from "./pull-request.handler";

function createRepositoryRow(
  position: number,
  repoOwner: string,
  repoName: string
): SessionRepositoryRow {
  return {
    position,
    repo_owner: repoOwner,
    repo_name: repoName,
    repo_id: position + 1,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
  };
}

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-session-1",
    title: "Session title",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 1,
    base_branch: "main",
    branch_name: "feature/test",
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    user_id: "user-1",
    scm_user_id: "scm-user-1",
    scm_login: "octocat",
    scm_email: "octocat@example.com",
    scm_name: "The Octocat",
    auth_name: null,
    role: "member",
    scm_access_token_encrypted: "enc-access",
    scm_refresh_token_encrypted: "enc-refresh",
    scm_token_expires_at: 1234,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const getSession = vi.fn<() => SessionRow | null>();
  let repositoryRows: SessionRepositoryRow[] = [];
  // Mirrors SessionRepository.getSessionRepositories: members derive from the
  // session scalars plus whatever rows the test seeds.
  const getSessionRepositories = vi.fn<() => SessionRepositoryEntry[]>(() => {
    const session = getSession();
    if (!session?.repo_owner || !session.repo_name) return [];
    return buildSessionRepositories(
      { repoOwner: session.repo_owner, repoName: session.repo_name },
      repositoryRows
    );
  });
  const getPromptingParticipantForPR = vi.fn();
  const resolveAuthForPR = vi.fn();
  const getSessionUrl = vi.fn();
  const createPullRequest = vi.fn();
  const getArtifactById = vi.fn<(artifactId: string) => ArtifactRow | null>(() => null);
  const updateArtifact = vi.fn();
  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(() => true) };
  const now = vi.fn(() => 5000);
  const triggerPullRequestRefresh = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;

  const pullRequestHandler = createPullRequestHandler({
    getSession,
    getSessionRepositories,
    getPromptingParticipantForPR,
    resolveAuthForPR,
    getSessionUrl,
    createPullRequest,
    getArtifactById,
    updateArtifact,
    messenger,
    now,
    triggerPullRequestRefresh,
  });

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    ...pullRequestHandler,
    createPr: (request: Request) => pullRequestHandler.createPr(request, log),
  };

  return {
    handler,
    log,
    getSession,
    getSessionRepositories,
    setRepositoryRows: (rows: SessionRepositoryRow[]) => {
      repositoryRows = rows;
    },
    getPromptingParticipantForPR,
    resolveAuthForPR,
    getSessionUrl,
    createPullRequest,
    getArtifactById,
    updateArtifact,
    broadcast,
    now,
    triggerPullRequestRefresh,
  };
}

describe("createPullRequestHandler", () => {
  it("returns 404 when session is missing", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("returns prompting participant error payload", async () => {
    const { handler, getSession, getPromptingParticipantForPR } = createHandler();
    getSession.mockReturnValue(createSession());
    getPromptingParticipantForPR.mockResolvedValue({
      error: "No active prompt found",
      status: 400,
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "No active prompt found" });
  });

  it("returns repository context error before participant lookup for no-repo sessions", async () => {
    const {
      handler,
      getSession,
      getPromptingParticipantForPR,
      resolveAuthForPR,
      createPullRequest,
    } = createHandler();
    getSession.mockReturnValue(
      createSession({ repo_owner: null, repo_name: null, repo_id: null, base_branch: null })
    );

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Pull requests require a repository context" });
    expect(getPromptingParticipantForPR).not.toHaveBeenCalled();
    expect(resolveAuthForPR).not.toHaveBeenCalled();
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed create PR bodies", async () => {
    const { handler, getSession, createPullRequest } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: null }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(createPullRequest).not.toHaveBeenCalled();
  });

  it("returns auth resolution error payload", async () => {
    const { handler, getSession, getPromptingParticipantForPR, resolveAuthForPR } = createHandler();
    const participant = createParticipant();
    getSession.mockReturnValue(createSession());
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({
      error: "Token expired",
      status: 401,
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Token expired" });
  });

  it("forwards service error and passes the raw base branch through", async () => {
    const {
      handler,
      getSession,
      getPromptingParticipantForPR,
      resolveAuthForPR,
      getSessionUrl,
      createPullRequest,
      log,
    } = createHandler();
    const session = createSession({ base_branch: "develop" });
    const participant = createParticipant({ user_id: "user-123" });
    getSession.mockReturnValue(session);
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({ auth: { authType: "oauth", token: "token" } });
    getSessionUrl.mockReturnValue("https://app.example.com/session/public-session-1");
    createPullRequest.mockResolvedValue({
      kind: "error",
      status: 409,
      error: "PR already exists",
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc", headBranch: "feature/pr" }),
      })
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "PR already exists" });
    // Base-branch defaulting is the service's job (per target repo) — the
    // handler forwards the request value untouched.
    expect(createPullRequest).toHaveBeenCalledWith(
      {
        title: "PR",
        body: "desc",
        headBranch: "feature/pr",
        baseBranch: undefined,
        repoOwner: "acme",
        repoName: "repo",
        promptingUserId: "user-123",
        promptingAuth: { authType: "oauth", token: "token" },
        sessionUrl: "https://app.example.com/session/public-session-1",
      },
      log
    );
  });

  it("allows repo sessions with null base branch to use service fallback", async () => {
    const {
      handler,
      getSession,
      getPromptingParticipantForPR,
      resolveAuthForPR,
      getSessionUrl,
      createPullRequest,
      log,
    } = createHandler();
    const participant = createParticipant({ user_id: "user-123" });
    getSession.mockReturnValue(createSession({ base_branch: null }));
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({ auth: null });
    getSessionUrl.mockReturnValue("https://app.example.com/session/public-session-1");
    createPullRequest.mockResolvedValue({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      state: "open",
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "PR", body: "desc" }),
      })
    );

    expect(response.status).toBe(200);
    expect(createPullRequest).toHaveBeenCalledWith(
      {
        title: "PR",
        body: "desc",
        baseBranch: undefined,
        repoOwner: "acme",
        repoName: "repo",
        promptingUserId: "user-123",
        promptingAuth: null,
        sessionUrl: "https://app.example.com/session/public-session-1",
      },
      log
    );
  });

  it("returns mapped success payload", async () => {
    const {
      handler,
      getSession,
      getPromptingParticipantForPR,
      resolveAuthForPR,
      getSessionUrl,
      createPullRequest,
      log,
    } = createHandler();
    const session = createSession();
    const participant = createParticipant();
    getSession.mockReturnValue(session);
    getPromptingParticipantForPR.mockResolvedValue({ participant });
    resolveAuthForPR.mockResolvedValue({ auth: null });
    getSessionUrl.mockReturnValue("https://app.example.com/session/public-session-1");
    createPullRequest.mockResolvedValue({
      kind: "created",
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      state: "open",
    });

    const response = await handler.createPr(
      new Request("http://internal/internal/create-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "PR",
          body: "desc",
          baseBranch: "release",
          headBranch: "feature/pr",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      prNumber: 42,
      prUrl: "https://github.com/acme/repo/pull/42",
      state: "open",
    });
    expect(createPullRequest).toHaveBeenCalledWith(
      {
        title: "PR",
        body: "desc",
        baseBranch: "release",
        headBranch: "feature/pr",
        repoOwner: "acme",
        repoName: "repo",
        promptingUserId: "user-1",
        promptingAuth: null,
        sessionUrl: "https://app.example.com/session/public-session-1",
      },
      log
    );
  });

  describe("repository targeting", () => {
    function createMultiRepoHandler() {
      const harness = createHandler();
      harness.getSession.mockReturnValue(createSession());
      harness.setRepositoryRows([
        createRepositoryRow(0, "acme", "repo"),
        createRepositoryRow(1, "acme", "backend"),
      ]);
      harness.getPromptingParticipantForPR.mockResolvedValue({
        participant: createParticipant(),
      });
      harness.resolveAuthForPR.mockResolvedValue({ auth: null });
      harness.getSessionUrl.mockReturnValue("https://app.example.com/session/public-session-1");
      harness.createPullRequest.mockResolvedValue({
        kind: "created",
        prNumber: 7,
        prUrl: "https://github.com/acme/backend/pull/7",
        state: "open",
      });
      return harness;
    }

    function postPr(handler: ReturnType<typeof createHandler>["handler"], body: unknown) {
      return handler.createPr(
        new Request("http://internal/internal/create-pr", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      );
    }

    it("returns 400 listing member repos when a multi-repo session omits the target", async () => {
      const { handler, createPullRequest } = createMultiRepoHandler();

      const response = await postPr(handler, { title: "PR", body: "desc" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error:
          "This session spans multiple repositories — specify repoOwner and repoName (one of: acme/repo, acme/backend)",
      });
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it("returns 400 when only one of repoOwner/repoName is provided", async () => {
      const { handler, createPullRequest } = createMultiRepoHandler();

      const response = await postPr(handler, { title: "PR", body: "desc", repoOwner: "acme" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "repoOwner and repoName must be provided together",
      });
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it("returns 403 when the target repo is not a session member", async () => {
      const { handler, createPullRequest } = createMultiRepoHandler();

      const response = await postPr(handler, {
        title: "PR",
        body: "desc",
        repoOwner: "evil",
        repoName: "exfil",
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: "Repository evil/exfil is not part of this session",
      });
      expect(createPullRequest).not.toHaveBeenCalled();
    });

    it("targets a secondary member with the list's canonical casing", async () => {
      const { handler, createPullRequest, log } = createMultiRepoHandler();

      const response = await postPr(handler, {
        title: "PR",
        body: "desc",
        repoOwner: "Acme",
        repoName: "Backend",
      });

      expect(response.status).toBe(200);
      expect(createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ repoOwner: "acme", repoName: "backend" }),
        log
      );
    });

    it("defaults to the sole member when the target is omitted", async () => {
      const harness = createMultiRepoHandler();
      harness.setRepositoryRows([createRepositoryRow(0, "acme", "repo")]);

      const response = await postPr(harness.handler, { title: "PR", body: "desc" });

      expect(response.status).toBe(200);
      expect(harness.createPullRequest).toHaveBeenCalledWith(
        expect.objectContaining({ repoOwner: "acme", repoName: "repo" }),
        harness.log
      );
    });
  });
});

function createPrArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://github.com/acme/repo/pull/7",
    metadata: JSON.stringify({
      number: 7,
      state: "open",
      lifecycleState: "open",
      isDraft: false,
      head: "open-inspect/public-session-1",
      base: "main",
      repoOwner: "acme",
      repoName: "repo",
    }),
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function createSnapshotPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: "https://github.com/acme/repo/pull/7",
    lifecycleState: "open",
    isDraft: false,
    headBranch: "open-inspect/public-session-1",
    baseBranch: "main",
    repoOwner: "acme",
    repoName: "repo",
    ...overrides,
  };
}

function postSnapshot(
  handler: ReturnType<typeof createHandler>["handler"],
  payload: unknown,
  artifactId: string | null = "artifact-1"
) {
  const search = artifactId === null ? "" : `?artifactId=${artifactId}`;
  const url = `http://internal/internal/pull-request-artifact-snapshot${search}`;
  return handler.pullRequestArtifactSnapshot(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    new URL(url)
  );
}

describe("pullRequestArtifactSnapshot", () => {
  it("returns 400 when artifactId is missing", async () => {
    const { handler } = createHandler();

    const response = await postSnapshot(handler, createSnapshotPayload(), null);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "artifactId query parameter is required" });
  });

  it("returns 400 on an invalid snapshot body", async () => {
    const { handler, getArtifactById } = createHandler();
    getArtifactById.mockReturnValue(createPrArtifact());

    const response = await postSnapshot(handler, createSnapshotPayload({ lifecycleState: "junk" }));

    expect(response.status).toBe(400);
  });

  it("rejects a terminal draft snapshot (invariant)", async () => {
    const { handler, getArtifactById } = createHandler();
    getArtifactById.mockReturnValue(createPrArtifact());

    const response = await postSnapshot(
      handler,
      createSnapshotPayload({ lifecycleState: "merged", isDraft: true })
    );

    expect(response.status).toBe(400);
  });

  it("returns 404 when the artifact is missing or not a PR artifact", async () => {
    const { handler, getArtifactById } = createHandler();
    getArtifactById.mockReturnValue(null);

    const missing = await postSnapshot(handler, createSnapshotPayload());
    expect(missing.status).toBe(404);

    getArtifactById.mockReturnValue(createPrArtifact({ type: "branch" }));
    const wrongType = await postSnapshot(handler, createSnapshotPayload());
    expect(wrongType.status).toBe(404);
  });

  it("applies a changed snapshot, advances updatedAt, and broadcasts artifact_updated", async () => {
    const { handler, getArtifactById, updateArtifact, broadcast } = createHandler();
    getArtifactById.mockReturnValue(createPrArtifact());

    const response = await postSnapshot(
      handler,
      createSnapshotPayload({
        lifecycleState: "merged",
        headSha: "abc123",
        providerUpdatedAt: 4000,
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });

    const expectedMetadata = {
      number: 7,
      state: "merged",
      lifecycleState: "merged",
      isDraft: false,
      head: "open-inspect/public-session-1",
      base: "main",
      repoOwner: "acme",
      repoName: "repo",
      headSha: "abc123",
      providerUpdatedAt: 4000,
    };
    expect(updateArtifact).toHaveBeenCalledWith("artifact-1", {
      url: "https://github.com/acme/repo/pull/7",
      metadata: JSON.stringify(expectedMetadata),
      updatedAt: 5000,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: "artifact_updated",
      artifact: {
        id: "artifact-1",
        type: "pr",
        url: "https://github.com/acme/repo/pull/7",
        metadata: expectedMetadata,
        createdAt: 1000,
        updatedAt: 5000,
      },
    });
  });

  it("preserves unknown legacy metadata keys", async () => {
    const { handler, getArtifactById, updateArtifact } = createHandler();
    getArtifactById.mockReturnValue(
      createPrArtifact({
        metadata: JSON.stringify({ number: 7, state: "open", legacyKey: "keep-me" }),
      })
    );

    const response = await postSnapshot(
      handler,
      createSnapshotPayload({ lifecycleState: "closed" })
    );

    expect(response.status).toBe(200);
    const written = JSON.parse(vi.mocked(updateArtifact).mock.calls[0][1].metadata as string) as {
      legacyKey?: string;
      state?: string;
    };
    expect(written.legacyKey).toBe("keep-me");
    expect(written.state).toBe("closed");
  });

  it("no-ops when the snapshot is materially identical", async () => {
    const { handler, getArtifactById, updateArtifact, broadcast } = createHandler();
    getArtifactById.mockReturnValue(createPrArtifact());

    const response = await postSnapshot(handler, createSnapshotPayload());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: false });
    expect(updateArtifact).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("rejects a snapshot older than the stored provider timestamp", async () => {
    const { handler, getArtifactById, updateArtifact, broadcast } = createHandler();
    getArtifactById.mockReturnValue(
      createPrArtifact({
        metadata: JSON.stringify({
          number: 7,
          lifecycleState: "merged",
          isDraft: false,
          providerUpdatedAt: 9000,
        }),
      })
    );

    const response = await postSnapshot(
      handler,
      createSnapshotPayload({ lifecycleState: "open", providerUpdatedAt: 4000 })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: false });
    expect(updateArtifact).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("applies when either side lacks a provider timestamp", async () => {
    const { handler, getArtifactById, updateArtifact } = createHandler();
    getArtifactById.mockReturnValue(
      createPrArtifact({
        metadata: JSON.stringify({ number: 7, providerUpdatedAt: 9000 }),
      })
    );

    // Incoming snapshot without a timestamp is authoritative (read-through).
    const response = await postSnapshot(
      handler,
      createSnapshotPayload({ lifecycleState: "closed" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(updateArtifact).toHaveBeenCalledTimes(1);
  });

  it("applies a url-only change (rename/transfer)", async () => {
    const { handler, getArtifactById, updateArtifact } = createHandler();
    getArtifactById.mockReturnValue(createPrArtifact());

    const response = await postSnapshot(
      handler,
      createSnapshotPayload({ url: "https://github.com/acme/renamed/pull/7" })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
    expect(vi.mocked(updateArtifact).mock.calls[0][1].url).toBe(
      "https://github.com/acme/renamed/pull/7"
    );
  });
});

describe("refreshPullRequests", () => {
  it("fires the background refresh and returns 202 immediately", async () => {
    const { handler, triggerPullRequestRefresh } = createHandler();

    const response = handler.refreshPullRequests();

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "refreshing" });
    expect(triggerPullRequestRefresh).toHaveBeenCalledTimes(1);
  });
});
