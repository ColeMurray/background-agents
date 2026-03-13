import { describe, expect, it, vi } from "vitest";
import type { ParticipantRow, SandboxRow, SessionRow } from "../../types";
import { createSessionLifecycleHandler } from "./session-lifecycle.handler";
import { getValidModelOrDefault } from "../../../utils/models";

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
    createSandbox: vi.fn(),
    createParticipant: vi.fn(),
    updateSessionTitle: vi.fn(),
  };
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
  };
  const getSession = vi.fn<() => SessionRow | null>();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const getPublicSessionId = vi.fn<(session: SessionRow) => string>();
  const getParticipantByUserId = vi.fn<(userId: string) => ParticipantRow | null>();
  const transitionSessionStatus = vi.fn<(status: SessionRow["status"]) => Promise<boolean>>();
  const stopExecution = vi.fn();
  const getSandboxSocket = vi.fn<() => WebSocket | null>();
  const sendToSandbox = vi.fn();
  const updateSandboxStatus = vi.fn();
  const broadcast = vi.fn();

  const handler = createSessionLifecycleHandler({
    repository,
    getDurableObjectId,
    tokenEncryptionKey: "encryption-key",
    encryptToken,
    validateReasoningEffort,
    generateId,
    now,
    scheduleWarmSandbox,
    getLog: () => log,
    getSession,
    getSandbox,
    getPublicSessionId,
    getParticipantByUserId,
    transitionSessionStatus,
    stopExecution,
    getSandboxSocket,
    sendToSandbox,
    updateSandboxStatus,
    broadcast,
  });

  return {
    handler,
    repository,
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
    transitionSessionStatus,
    stopExecution,
    getSandboxSocket,
    sendToSandbox,
    updateSandboxStatus,
    broadcast,
  };
}

describe("createSessionLifecycleHandler", () => {
  it("initializes session, sandbox, and owner participant", async () => {
    const {
      handler,
      repository,
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
          userId: "user-1",
          scmLogin: "octocat",
          scmName: "The Octocat",
          scmEmail: "octocat@example.com",
          scmToken: "plain-scm-token",
          parentSessionId: "parent-1",
          spawnSource: "agent",
          spawnDepth: 1,
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
      createdAt: 1234,
      updatedAt: 1234,
    });
    expect(repository.createSandbox).toHaveBeenCalledWith({
      id: "sandbox-1",
      status: "pending",
      gitSyncStatus: "pending",
      createdAt: 0,
    });
    expect(repository.createParticipant).toHaveBeenCalledWith({
      id: "participant-1",
      userId: "user-1",
      scmLogin: "octocat",
      scmName: "The Octocat",
      scmEmail: "octocat@example.com",
      scmAccessTokenEncrypted: "encrypted-scm-token",
      role: "owner",
      joinedAt: 1234,
    });
    expect(scheduleWarmSandbox).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Triggering sandbox spawn for new session");
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

  it("updates title, broadcasts, and returns new title", async () => {
    const { handler, getSession, getParticipantByUserId, repository, broadcast } = createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(createParticipant());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1", title: "New Title" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "New Title" });
    expect(repository.updateSessionTitle).toHaveBeenCalledWith("session-1", "New Title", 1234);
    expect(broadcast).toHaveBeenCalledWith({ type: "session_title", title: "New Title" });
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
    const { handler, getSession, getParticipantByUserId, transitionSessionStatus } =
      createHandler();
    getSession.mockReturnValue(createSession());
    getParticipantByUserId.mockReturnValue(createParticipant());
    transitionSessionStatus.mockResolvedValue(true);

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "archived" });
    expect(transitionSessionStatus).toHaveBeenCalledWith("archived");
  });

  it("unarchives successfully for participant", async () => {
    const { handler, getSession, getParticipantByUserId, transitionSessionStatus } =
      createHandler();
    getSession.mockReturnValue(createSession({ status: "archived" }));
    getParticipantByUserId.mockReturnValue(createParticipant());
    transitionSessionStatus.mockResolvedValue(true);

    const response = await handler.unarchive(
      new Request("http://internal/internal/unarchive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "active" });
    expect(transitionSessionStatus).toHaveBeenCalledWith("active");
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
      stopExecution,
      transitionSessionStatus,
      getSandboxSocket,
      sendToSandbox,
      updateSandboxStatus,
    } = createHandler();
    const ws = {} as WebSocket;
    getSession.mockReturnValue(createSession({ status: "active" }));
    getSandbox.mockReturnValue(createSandbox({ status: "running" }));
    stopExecution.mockResolvedValue(undefined);
    transitionSessionStatus.mockResolvedValue(true);
    getSandboxSocket.mockReturnValue(ws);

    const response = await handler.cancel();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelled" });
    expect(stopExecution).toHaveBeenCalledWith({ suppressStatusReconcile: true });
    expect(transitionSessionStatus).toHaveBeenCalledWith("cancelled");
    expect(sendToSandbox).toHaveBeenCalledWith(ws, { type: "shutdown" });
    expect(updateSandboxStatus).toHaveBeenCalledWith("stopped");
  });
});
