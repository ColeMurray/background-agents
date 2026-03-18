import { describe, expect, it, vi } from "vitest";
import { createChildSessionsHandler } from "./child-sessions.handler";
import type { ArtifactRow, EventRow, ParticipantRow, SandboxRow, SessionRow } from "../../types";

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: null,
    title: "Session Title",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 123,
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
    created_at: 1000,
    updated_at: 2000,
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
    role: "owner",
    scm_access_token_encrypted: "enc-access",
    scm_refresh_token_encrypted: "enc-refresh",
    scm_token_expires_at: 1234,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1,
    ...overrides,
  };
}

function createSandbox(overrides: Partial<SandboxRow> = {}): SandboxRow {
  return {
    id: "sandbox-1",
    modal_sandbox_id: null,
    modal_object_id: null,
    snapshot_id: null,
    snapshot_image_id: null,
    auth_token: null,
    auth_token_hash: null,
    status: "running",
    git_sync_status: "pending",
    last_heartbeat: null,
    last_activity: null,
    last_spawn_error: null,
    last_spawn_error_at: null,
    code_server_url: null,
    code_server_password: null,
    created_at: 1,
    ...overrides,
  };
}

function createArtifact(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: "artifact-1",
    type: "pr",
    url: "https://example.com/pr/1",
    metadata: null,
    created_at: 1,
    ...overrides,
  };
}

function createEvent(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: "event-1",
    type: "error",
    data: '{"message":"boom"}',
    message_id: null,
    created_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const repository = {
    listParticipants: vi.fn(),
    listArtifacts: vi.fn(),
    listEvents: vi.fn(),
  };
  const getSession = vi.fn<() => SessionRow | null>();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const getPublicSessionId = vi.fn<(session: SessionRow) => string>();
  const broadcast = vi.fn();

  const handler = createChildSessionsHandler({
    repository,
    getSession,
    getSandbox,
    getPublicSessionId,
    broadcast,
  });

  return {
    handler,
    repository,
    getSession,
    getSandbox,
    getPublicSessionId,
    broadcast,
  };
}

describe("createChildSessionsHandler", () => {
  it("returns 404 when session is missing for spawn context", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("returns 404 when owner participant is missing", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession());
    repository.listParticipants.mockReturnValue([createParticipant({ role: "member" })]);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "No owner participant found" });
  });

  it("maps spawn context from session and owner participant", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession({ reasoning_effort: "high" }));
    repository.listParticipants.mockReturnValue([createParticipant()]);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      repoOwner: "acme",
      repoName: "repo",
      repoId: 123,
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      baseBranch: "main",
      owner: {
        userId: "user-1",
        scmUserId: null,
        scmLogin: "octocat",
        scmName: "The Octocat",
        scmEmail: "octocat@example.com",
        scmAccessTokenEncrypted: "enc-access",
        scmRefreshTokenEncrypted: "enc-refresh",
        scmTokenExpiresAt: 1234,
      },
    });
  });

  it("propagates non-default branch in spawn context", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession({ base_branch: "feature/branch-fix" }));
    repository.listParticipants.mockReturnValue([createParticipant()]);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.baseBranch).toBe("feature/branch-fix");
  });

  it("returns 404 when session is missing for child summary", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = handler.getChildSummary();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("maps child summary and filters noisy events", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository } = createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());
    getPublicSessionId.mockReturnValue("public-session-1");

    repository.listArtifacts.mockReturnValue([
      createArtifact({ type: "pr", metadata: '{"number":42}' }),
      createArtifact({ type: "preview", metadata: null }),
    ]);
    repository.listEvents.mockReturnValue([
      createEvent({ id: "e1", type: "token", data: '{"token":"x"}', created_at: 9 }),
      createEvent({ id: "e2", type: "error", data: '{"message":"boom"}', created_at: 8 }),
      createEvent({ id: "e3", type: "heartbeat", data: '{"ok":true}', created_at: 7 }),
      createEvent({ id: "e4", type: "git_sync", data: '{"state":"done"}', created_at: 6 }),
      createEvent({ id: "e5", type: "push_error", data: '{"code":"denied"}', created_at: 5 }),
      createEvent({ id: "e6", type: "step_start", data: '{"step":1}', created_at: 4 }),
      createEvent({ id: "e7", type: "user_message", data: '{"text":"hi"}', created_at: 3 }),
      createEvent({ id: "e8", type: "tool_call", data: '{"name":"ls"}', created_at: 2 }),
      createEvent({
        id: "e9",
        type: "execution_complete",
        data: '{"status":"success"}',
        created_at: 1,
      }),
    ]);

    const response = handler.getChildSummary();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: {
        id: "public-session-1",
        title: "Session Title",
        status: "active",
        repoOwner: "acme",
        repoName: "repo",
        branchName: "feature/test",
        model: "anthropic/claude-haiku-4-5",
        createdAt: 1000,
        updatedAt: 2000,
      },
      sandbox: { status: "running" },
      artifacts: [
        {
          type: "pr",
          url: "https://example.com/pr/1",
          metadata: { number: 42 },
        },
        {
          type: "preview",
          url: "https://example.com/pr/1",
          metadata: null,
        },
      ],
      recentEvents: [
        { type: "error", data: { message: "boom" }, createdAt: 8 },
        { type: "git_sync", data: { state: "done" }, createdAt: 6 },
        { type: "push_error", data: { code: "denied" }, createdAt: 5 },
        { type: "user_message", data: { text: "hi" }, createdAt: 3 },
        { type: "tool_call", data: { name: "ls" }, createdAt: 2 },
      ],
    });
    expect(repository.listEvents).toHaveBeenCalledWith({ limit: 50 });
  });

  it("returns 400 when child session update body is missing required fields", async () => {
    const { handler, broadcast } = createHandler();

    const response = await handler.childSessionUpdate(
      new Request("http://internal/internal/child-session/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childSessionId: "child-1" }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "childSessionId and status are required" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("broadcasts child session update when payload is valid", async () => {
    const { handler, broadcast } = createHandler();

    const response = await handler.childSessionUpdate(
      new Request("http://internal/internal/child-session/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          childSessionId: "child-1",
          status: "completed",
          title: "Child title",
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(broadcast).toHaveBeenCalledWith({
      type: "child_session_update",
      childSessionId: "child-1",
      status: "completed",
      title: "Child title",
    });
  });
});
