import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../logger";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import { createSessionLifecycleHandler } from "./session-lifecycle.handler";
import type { SessionStatusService } from "../../session-status-service";
import type { ParticipantRepository } from "../../participant-repository";
import type { MessageRepository } from "../../message-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { SessionCoreRepository } from "../../session-core-repository";
import { getValidModelOrDefault } from "@open-inspect/shared/models";

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
    base_sha: "base-sha",
    current_sha: "head-sha",
    opencode_session_id: "oc-1",
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: "high",
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function createSandbox(overrides: Partial<SandboxRow> = {}): SandboxRow {
  return {
    id: "sandbox-1",
    modal_sandbox_id: "modal-1",
    modal_object_id: null,
    snapshot_id: null,
    snapshot_image_id: null,
    auth_token: null,
    auth_token_hash: null,
    status: "running",
    git_sync_status: "pending",
    last_heartbeat: 999,
    last_activity: null,
    last_spawn_error: null,
    last_spawn_error_at: null,
    code_server_url: null,
    code_server_password: null,
    vnc_url: null,
    vnc_password: null,
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
    created_at: 1,
    ...overrides,
  };
}

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "participant-1",
    user_id: "user-1",
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: "octocat@example.com",
    scm_name: "The Octocat",
    auth_name: null,
    role: "member",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const repository = {
    upsertSession: vi.fn(),
    replaceSessionRepositories: vi.fn(),
    createParticipant: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 0),
    getMessageCount: vi.fn(() => 0),
  };
  const sandboxRepository = { createSandbox: vi.fn() } as unknown as SandboxRepository;
  const getDurableObjectId = vi.fn(() => "session-do-id");
  const encryptToken = vi.fn();
  const validateReasoningEffort = vi.fn();
  const generateId = vi.fn();
  const now = vi.fn(() => 1234);
  const scheduleWarmSandbox = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  const getSession = vi.fn<() => SessionRow | null>();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const getPublicSessionId = vi.fn<(session: SessionRow) => string>();
  const getParticipantByUserId = vi.fn<(userId: string) => ParticipantRow | null>();
  const transition = vi.fn<(status: SessionRow["status"]) => Promise<boolean>>();
  const repairIndexStatus = vi.fn<() => Promise<void>>();
  const settleFromMessageState = vi.fn<() => Promise<SessionRow["status"]>>();
  const statusService = {
    transition,
    repairIndexStatus,
    settleFromMessageState,
  } as unknown as SessionStatusService;
  const applySessionTitleUpdate = vi.fn((title: string) => ({ ok: true as const, title }));
  const cancelSession = vi.fn();
  const getSandboxSocket = vi.fn<() => WebSocket | null>();
  const sendToSandbox = vi.fn();
  const updateSandboxStatus = vi.fn();

  const lifecycleHandler = createSessionLifecycleHandler({
    sessionCoreRepository: repository as unknown as SessionCoreRepository,
    sandboxRepository,
    messageRepository: repository as unknown as MessageRepository,
    participantRepository: repository as unknown as ParticipantRepository,
    getDurableObjectId,
    tokenEncryptionKey: "encryption-key",
    encryptToken,
    validateReasoningEffort,
    generateId,
    now,
    scheduleWarmSandbox,
    getSession,
    getSandbox,
    getPublicSessionId,
    getParticipantByUserId,
    statusService,
    applySessionTitleUpdate,
    cancelSession,
    getSandboxSocket,
    sendToSandbox,
    updateSandboxStatus,
  });

  // Bind the request-scoped log so call sites exercise the threading without
  // repeating it at every invocation.
  const handler = {
    ...lifecycleHandler,
    init: (request: Request) => lifecycleHandler.init(request, log),
  };

  return {
    handler,
    repository,
    sandboxRepository,
    getDurableObjectId,
    encryptToken,
    validateReasoningEffort,
    generateId,
    now,
    scheduleWarmSandbox,
    log,
    getSession,
    getSandbox,
    getPublicSessionId,
    getParticipantByUserId,
    transition,
    repairIndexStatus,
    settleFromMessageState,
    applySessionTitleUpdate,
    cancelSession,
    getSandboxSocket,
    sendToSandbox,
    updateSandboxStatus,
  };
}

describe("createSessionLifecycleHandler", () => {
  it.each([
    ["repoOwner without repoName", { repoOwner: "acme", repoName: null }],
    ["repoId without repository context", { repoOwner: null, repoName: null, repoId: 123 }],
    ["repository context without repoId", { repoOwner: "acme", repoName: "repo", repoId: null }],
  ])("rejects partial repository contexts during init: %s", async (_name, repoFields) => {
    const { handler, repository, sandboxRepository, scheduleWarmSandbox } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          ...repoFields,
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Repository context must include repoOwner, repoName, and repoId together",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(sandboxRepository.createSandbox).not.toHaveBeenCalled();
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
  });

  it("initializes session, sandbox, and owner participant", async () => {
    const {
      handler,
      repository,
      sandboxRepository,
      getDurableObjectId,
      encryptToken,
      validateReasoningEffort,
      generateId,
      scheduleWarmSandbox,
      log,
    } = createHandler();
    getDurableObjectId.mockReturnValue("session-do-id");
    encryptToken.mockResolvedValue("encrypted-scm-token");
    validateReasoningEffort.mockReturnValue("high");
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "repo",
          repoId: 123,
          defaultBranch: "main",
          branch: "feature/work",
          title: "Session title",
          model: "anthropic/claude-haiku-4-5",
          reasoningEffort: "high",
          userId: "slack:U123",
          canonicalUserId: "canonical-user-1",
          scmLogin: "octocat",
          scmName: "The Octocat",
          scmEmail: "octocat@example.com",
          scmToken: "plain-scm-token",
          scmRefreshTokenEncrypted: "encrypted-refresh-token",
          scmTokenExpiresAt: 9999999,
          scmUserId: "github-user-123",
          parentSessionId: "parent-1",
          spawnSource: "agent",
          spawnDepth: 1,
          vncEnabled: true,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: "session-do-id", status: "created" });
    expect(repository.upsertSession).toHaveBeenCalledWith({
      id: "session-do-id",
      sessionName: "session-public-id",
      title: "Session title",
      repoOwner: "acme",
      repoName: "repo",
      repoId: 123,
      baseBranch: "feature/work",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      status: "created",
      parentSessionId: "parent-1",
      spawnSource: "agent",
      spawnDepth: 1,
      codeServerEnabled: false,
      vncEnabled: true,
      sandboxSettings: null,
      environmentId: null,
      createdAt: 1234,
      updatedAt: 1234,
    });
    expect(sandboxRepository.createSandbox).toHaveBeenCalledWith({
      id: "sandbox-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });
    expect(repository.createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "slack:U123",
      canonicalUserId: "canonical-user-1",
      scmUserId: "github-user-123",
      scmLogin: "octocat",
      scmName: "The Octocat",
      scmEmail: "octocat@example.com",
      scmAccessTokenEncrypted: "encrypted-scm-token",
      scmRefreshTokenEncrypted: "encrypted-refresh-token",
      scmTokenExpiresAt: 9999999,
      role: "owner",
      joinedAt: 1234,
    });
    // Scalar init synthesizes a one-entry member set.
    expect(repository.replaceSessionRepositories).toHaveBeenCalledWith([
      {
        position: 0,
        repoOwner: "acme",
        repoName: "repo",
        repoId: 123,
        baseBranch: "feature/work",
      },
    ]);
    expect(scheduleWarmSandbox).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Triggering sandbox spawn for new session");
  });

  it("persists the repositories list in position order", async () => {
    const { handler, repository, validateReasoningEffort, generateId } = createHandler();
    validateReasoningEffort.mockReturnValue(null);
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "frontend",
          repoId: 1,
          defaultBranch: "main",
          repositories: [
            { repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
            { repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
          ],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.replaceSessionRepositories).toHaveBeenCalledWith([
      { position: 0, repoOwner: "acme", repoName: "frontend", repoId: 1, baseBranch: "main" },
      { position: 1, repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "develop" },
    ]);
  });

  it("persists an empty member set for repo-less sessions", async () => {
    const { handler, repository, validateReasoningEffort, generateId } = createHandler();
    validateReasoningEffort.mockReturnValue(null);
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.replaceSessionRepositories).toHaveBeenCalledWith([]);
  });

  it("accepts nullable init fields and sandbox settings", async () => {
    const { handler, repository, validateReasoningEffort, generateId } = createHandler();
    validateReasoningEffort.mockReturnValue(null);
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          repoId: null,
          environmentId: null,
          // initialize.ts forwards these straight from SessionInitInput, where
          // every one of them is nullable — the schema must accept null, not
          // just absence, or session creation 400s.
          reasoningEffort: null,
          canonicalUserId: null,
          scmLogin: null,
          scmName: null,
          scmEmail: null,
          scmToken: null,
          scmTokenEncrypted: null,
          scmRefreshTokenEncrypted: null,
          scmTokenExpiresAt: null,
          scmUserId: null,
          parentSessionId: null,
          sandboxSettings: { cpuCores: null, memoryMib: null, tunnelPorts: [3000] },
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repoOwner: null,
        repoName: null,
        repoId: null,
        environmentId: null,
        parentSessionId: null,
      })
    );
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        scmLogin: null,
        scmName: null,
        scmEmail: null,
      })
    );
    const upsert = repository.upsertSession.mock.calls[0]![0];
    expect(JSON.parse(upsert.sandboxSettings!)).toEqual({
      cpuCores: null,
      memoryMib: null,
      tunnelPorts: [3000],
    });
  });

  it("preserves optional init fields the schema must not silently drop", async () => {
    const { handler, repository, validateReasoningEffort, generateId } = createHandler();
    validateReasoningEffort.mockReturnValue("high");
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          repoId: null,
          userId: "user-1",
          canonicalUserId: "platform-user-1",
          vncEnabled: true,
          // sandboxTimeoutMs is validated by normalizeSandboxSettings, not by a
          // restated field list — a hand-copied schema would drop it here.
          sandboxSettings: { sandboxTimeoutMs: 14_400_000, vncPort: 6080 },
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({ vncEnabled: true })
    );
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({ canonicalUserId: "platform-user-1" })
    );
    const upsert = repository.upsertSession.mock.calls[0]![0];
    expect(JSON.parse(upsert.sandboxSettings!)).toEqual({
      sandboxTimeoutMs: 14_400_000,
      vncPort: 6080,
    });
  });

  it("rejects malformed init bodies before creating records", async () => {
    const { handler, repository, sandboxRepository, scheduleWarmSandbox } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          userId: 123,
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(sandboxRepository.createSandbox).not.toHaveBeenCalled();
    expect(repository.createParticipant).not.toHaveBeenCalled();
    expect(scheduleWarmSandbox).not.toHaveBeenCalled();
  });

  it("rejects a repositories list whose primary does not match the scalar mirror", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "frontend",
          repoId: 1,
          defaultBranch: "main",
          repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "main" }],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "repositories[0] must match the scalar repository mirror",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
    expect(repository.replaceSessionRepositories).not.toHaveBeenCalled();
  });

  it("rejects an explicit empty repositories list alongside scalar context", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "frontend",
          repoId: 1,
          repositories: [],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "repositories must include the scalar repository",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
  });

  it("rejects a repositories list on a repo-less session", async () => {
    const { handler, repository } = createHandler();

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: null,
          repoName: null,
          repositories: [{ repoOwner: "acme", repoName: "backend", repoId: 2, baseBranch: "main" }],
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "repositories[0] must match the scalar repository mirror",
    });
    expect(repository.upsertSession).not.toHaveBeenCalled();
  });

  it("falls back to pre-encrypted token when plain-token encryption fails", async () => {
    const { handler, repository, encryptToken, validateReasoningEffort, generateId, log } =
      createHandler();
    encryptToken.mockRejectedValue(new Error("encrypt failed"));
    validateReasoningEffort.mockReturnValue(null);
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "repo",
          repoId: 123,
          userId: "user-1",
          scmToken: "plain-scm-token",
          scmTokenEncrypted: "existing-encrypted-token",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.createParticipant).toHaveBeenCalledWith(
      expect.objectContaining({
        scmAccessTokenEncrypted: "existing-encrypted-token",
      })
    );
    expect(log.error).toHaveBeenCalledWith(
      "Failed to encrypt SCM token",
      expect.objectContaining({ error: expect.any(Error) })
    );
  });

  it("logs invalid model warning and stores normalized model", async () => {
    const { handler, repository, validateReasoningEffort, generateId, log } = createHandler();
    validateReasoningEffort.mockReturnValue(null);
    generateId.mockReturnValueOnce("sandbox-1").mockReturnValueOnce("participant-1");

    const response = await handler.init(
      new Request("http://internal/internal/init", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionName: "session-public-id",
          repoOwner: "acme",
          repoName: "repo",
          repoId: 123,
          model: "invalid/model-name",
          userId: "user-1",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(repository.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: getValidModelOrDefault("invalid/model-name"),
      })
    );
    expect(log.warn).toHaveBeenCalledWith("Invalid model name, using default", {
      requested_model: "invalid/model-name",
      default_model: getValidModelOrDefault("invalid/model-name"),
    });
  });

  it("returns 404 state response when session is missing", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = handler.getState();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Session not found");
  });

  it("maps state response with sandbox details", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId } = createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());
    getPublicSessionId.mockReturnValue("public-session-1");

    const response = handler.getState();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "public-session-1",
      title: "Session title",
      repoOwner: "acme",
      repoName: "repo",
      baseBranch: "main",
      branchName: "feature/test",
      baseSha: "base-sha",
      currentSha: "head-sha",
      opencodeSessionId: "oc-1",
      status: "active",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      createdAt: 1000,
      updatedAt: 2000,
      sandbox: {
        id: "sandbox-1",
        modalSandboxId: "modal-1",
        status: "running",
        gitSyncStatus: "pending",
        lastHeartbeat: 999,
      },
    });
  });

  it("returns 404 when updating title for missing session", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: "New Title" }),
      })
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for invalid updateTitle body", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      })
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for malformed updateTitle fields", async () => {
    const { handler, getSession, applySessionTitleUpdate } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: 123 }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(applySessionTitleUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 for empty title", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: "" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title must be a non-empty string" });
  });

  it("returns 400 for title over 200 characters", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: "a".repeat(201) }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "title must be 200 characters or fewer" });
  });

  it("returns 403 when non-participant tries to update title", async () => {
    const { handler, getSession, getParticipantByUserId } = createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(null);

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: "New Title" }),
      })
    );

    expect(response.status).toBe(403);
  });

  it("applies a manual title update and returns the normalized title", async () => {
    const { handler, getSession, getParticipantByUserId, applySessionTitleUpdate } =
      createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(createParticipant());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: " New Title " }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "New Title" });
    expect(applySessionTitleUpdate).toHaveBeenCalledWith("New Title", { onlyIfUnset: false });
  });

  it("returns 400 for invalid archive body", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{invalid",
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
  });

  it("returns 400 for malformed archive fields", async () => {
    const { handler, getSession, getParticipantByUserId } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: 123 }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(getParticipantByUserId).not.toHaveBeenCalled();
  });

  it("returns 403 when archive user is not a participant", async () => {
    const { handler, getSession, getParticipantByUserId } = createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(null);

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Not authorized to archive this session" });
  });

  it("archives successfully for participant", async () => {
    const { handler, getSession, getParticipantByUserId, transition } = createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(createParticipant());
    transition.mockResolvedValue(true);

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "archived" });
    expect(transition).toHaveBeenCalledWith("archived");
  });

  it("archives a draft that was never prompted", async () => {
    const { handler, getSession, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "created" }));
    transition.mockResolvedValue(true);

    const response = await handler.expireDraft();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "archived", status: "archived" });
    expect(transition).toHaveBeenCalledWith("archived");
  });

  // `created` with messages is unreachable under current code: enqueuePromptCore
  // inserts the message and transitions to `active` in the same durable object
  // turn. Returning the session unchanged is what let legacy rows in that shape
  // pin the head of the sweep's oldest-first batch forever, so the invariant
  // under test is that every one of these branches leaves `created` behind.
  it("settles a draft that still holds queued work", async () => {
    const { handler, getSession, repository, transition, settleFromMessageState } = createHandler();
    getSession.mockReturnValue(createSession({ status: "created" }));
    repository.getPendingOrProcessingCount.mockReturnValue(1);
    settleFromMessageState.mockResolvedValue("active");

    const response = await handler.expireDraft();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "has_work", status: "active" });
    expect(settleFromMessageState).toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalledWith("archived");
  });

  it("settles a draft whose latest terminal message failed", async () => {
    const { handler, getSession, repository, settleFromMessageState } = createHandler();
    getSession.mockReturnValue(createSession({ status: "created" }));
    repository.getMessageCount.mockReturnValue(2);
    repository.getPendingOrProcessingCount.mockReturnValue(0);
    settleFromMessageState.mockResolvedValue("failed");

    const response = await handler.expireDraft();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "has_work", status: "failed" });
    expect(settleFromMessageState).toHaveBeenCalled();
  });

  it("never archives a draft that holds work", async () => {
    // Archiving would discard a real queued request, and `archived` is not
    // promptable, so the request could not even be resumed afterwards.
    const { handler, getSession, repository, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "created" }));
    repository.getPendingOrProcessingCount.mockReturnValue(1);

    await handler.expireDraft();

    expect(transition).not.toHaveBeenCalledWith("archived");
  });

  it("reports failure when stale index repair fails", async () => {
    const { handler, getSession, repairIndexStatus } = createHandler();
    getSession.mockReturnValue(createSession({ status: "archived" }));
    repairIndexStatus.mockRejectedValue(new Error("d1 down"));

    await expect(handler.expireDraft()).rejects.toThrow(/d1 down/);
  });

  it("does not expire a session that has left the draft status", async () => {
    const { handler, getSession, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "active" }));

    const response = await handler.expireDraft();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: "not_draft", status: "active" });
    expect(transition).not.toHaveBeenCalledWith("archived");
  });

  it("repairs a stale index without claiming new activity", async () => {
    // A session reaches this branch when the index still reads `created` while
    // the durable object has moved on. Repairing through `transition` would send
    // the durable object's own `updated_at`, which the index rejects whenever D1
    // is the newer of the two — a silent no-op that leaves the row selectable
    // forever. The repair projects status alone instead.
    const { handler, getSession, transition, repairIndexStatus } = createHandler();
    getSession.mockReturnValue(createSession({ status: "archived" }));

    const response = await handler.expireDraft();

    expect(await response.json()).toEqual({ outcome: "not_draft", status: "archived" });
    expect(repairIndexStatus).toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("returns 404 when expiring a missing session", async () => {
    const { handler, getSession, transition } = createHandler();
    getSession.mockReturnValue(null);

    const response = await handler.expireDraft();

    expect(response.status).toBe(404);
    expect(transition).not.toHaveBeenCalled();
  });

  it("returns 409 when archiving a session with queued work", async () => {
    const { handler, getSession, getParticipantByUserId, repository, transition } = createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(createParticipant());
    repository.getPendingOrProcessingCount.mockReturnValue(1);

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(transition).not.toHaveBeenCalled();
  });

  it("returns 409 when archiving a cancelled session", async () => {
    const { handler, getSession, getParticipantByUserId, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "cancelled" }));
    getParticipantByUserId.mockReturnValue(createParticipant());

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(transition).not.toHaveBeenCalled();
  });

  it("unarchives successfully for participant", async () => {
    const { handler, getSession, getParticipantByUserId, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "archived" }));
    getParticipantByUserId.mockReturnValue(createParticipant());
    transition.mockResolvedValue(true);

    const response = await handler.unarchive(
      new Request("http://internal/internal/unarchive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "active" });
    expect(transition).toHaveBeenCalledWith("active");
  });

  it("returns 409 when unarchiving a session that is not archived", async () => {
    const { handler, getSession, getParticipantByUserId, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "cancelled" }));
    getParticipantByUserId.mockReturnValue(createParticipant());

    const response = await handler.unarchive(
      new Request("http://internal/internal/unarchive", {
        method: "POST",
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(transition).not.toHaveBeenCalled();
  });

  it("returns 409 when cancelling terminal session", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(createSession({ status: "completed" }));

    const response = await handler.cancel();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Session already completed" });
  });

  it("cancels and shuts down running sandbox", async () => {
    const {
      handler,
      getSession,
      getSandbox,
      cancelSession,
      getSandboxSocket,
      sendToSandbox,
      updateSandboxStatus,
    } = createHandler();
    const ws = {} as WebSocket;
    getSession.mockReturnValue(createSession({ status: "active" }));
    getSandbox.mockReturnValue(createSandbox({ status: "running" }));
    cancelSession.mockResolvedValue(undefined);
    getSandboxSocket.mockReturnValue(ws);

    const response = await handler.cancel();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelled" });
    expect(cancelSession).toHaveBeenCalledOnce();
    expect(sendToSandbox).toHaveBeenCalledWith(ws, { type: "shutdown" });
    expect(updateSandboxStatus).toHaveBeenCalledWith("stopped");
  });
});
