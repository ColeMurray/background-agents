import { describe, expect, it, vi } from "vitest";
import { MAX_CHILD_FOLLOW_UP_PROMPT_CHARS } from "@open-inspect/shared/types/session-api";
import { createChildSessionsHandler } from "./child-sessions.handler";
import { PromptQueueFullError, SessionNotPromptableError } from "../../message-queue";
import {
  FINAL_RESPONSE_EVENT_PAGE_LIMIT,
  FINAL_RESPONSE_MAX_EVENTS,
  collectFinalResponseEventRows,
} from "./child-session-summary";
import type {
  ArtifactRow,
  EventRow,
  MessageRow,
  ParticipantRow,
  SandboxRow,
  SessionRow,
} from "../../types";
import type { ArtifactRepository } from "../../artifact-repository";
import type { ParticipantRepository } from "../../participant-repository";
import type { EventRepository } from "../../event-repository";
import type { MessageRepository } from "../../message-repository";

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
    vnc_enabled: 0,
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
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: "octocat@example.com",
    scm_name: "The Octocat",
    auth_name: null,
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
    vnc_url: null,
    vnc_password: null,
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
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
    updated_at: 1,
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

function createMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "message-1",
    author_id: "user-1",
    content: "Do the thing",
    source: "web",
    model: null,
    reasoning_effort: null,
    attachments: null,
    callback_context: null,
    client_request_id: null,
    request_fingerprint: null,
    status: "completed",
    error_message: null,
    stop_confirmation_deadline: null,
    created_at: 1,
    started_at: 2,
    completed_at: 3,
    ...overrides,
  };
}

function createHandler() {
  const repository = {
    listParticipants: vi.fn(),
    getProcessingMessageAuthor: vi.fn<() => { author_id: string } | null>(() => ({
      author_id: "participant-1",
    })),
    getParticipantById: vi.fn<(id: string) => ParticipantRow | null>(() => createParticipant()),
    listEventPage: vi.fn(),
    getLatestTerminalMessage: vi.fn(),
    getEventTimelinePage: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 0),
  };
  const artifactRepository = { listArtifacts: vi.fn() };
  const getSession = vi.fn<() => SessionRow | null>();
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const getPublicSessionId = vi.fn<(session: SessionRow) => string>();
  const parseArtifactMetadata = vi.fn((artifact: Pick<ArtifactRow, "metadata">) =>
    artifact.metadata ? (JSON.parse(artifact.metadata) as Record<string, unknown>) : null
  );
  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const enqueuePrompt = vi.fn(async () => ({
    messageId: "message-follow-up",
    status: "queued" as const,
  }));
  const messageService = { enqueuePrompt };

  const handler = createChildSessionsHandler({
    messageRepository: repository as unknown as MessageRepository,
    eventRepository: repository as unknown as EventRepository,
    participantRepository: repository as unknown as ParticipantRepository,
    artifactRepository: artifactRepository as unknown as ArtifactRepository,
    getSession,
    getSandbox,
    getPublicSessionId,
    parseArtifactMetadata,
    messenger,
    messageService,
  });

  return {
    handler,
    repository,
    artifactRepository,
    getSession,
    getSandbox,
    getPublicSessionId,
    parseArtifactMetadata,
    broadcast,
    enqueuePrompt,
  };
}

describe("createChildSessionsHandler", () => {
  describe("parentPrompt", () => {
    function request(body: unknown): Request {
      const withAuthor =
        typeof body === "object" && body !== null
          ? {
              ...body,
              author: {
                userId: "owner-1",
                canonicalUserId: "canonical-1",
                scmUserId: null,
                scmLogin: null,
                scmName: null,
                scmEmail: null,
              },
            }
          : body;
      return new Request("http://internal/internal/parent-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(withAuthor),
      });
    }

    it("queues a parent follow-up as the propagated prompt author", async () => {
      const { handler, getSession, repository, enqueuePrompt } = createHandler();
      getSession.mockReturnValue(createSession({ parent_session_id: "parent-1" }));
      repository.listParticipants.mockReturnValue([
        createParticipant({ user_id: "owner-1", canonical_user_id: "canonical-1" }),
      ]);

      const response = await handler.parentPrompt(
        request({ parentSessionId: "parent-1", content: "Continue with the edge cases" })
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        messageId: "message-follow-up",
        status: "queued",
      });
      expect(enqueuePrompt).toHaveBeenCalledWith({
        content: "Continue with the edge cases",
        authorId: "owner-1",
        canonicalUserId: "canonical-1",
        source: "agent",
        scmEnrichment: {
          userId: null,
          login: null,
          name: null,
          email: null,
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          tokenExpiresAt: null,
        },
      });
    });

    it("returns distinct validation reasons for blank and oversized prompts", async () => {
      const { handler } = createHandler();

      const blank = await handler.parentPrompt(
        request({ parentSessionId: "parent-1", content: "" })
      );
      const oversized = await handler.parentPrompt(
        request({
          parentSessionId: "parent-1",
          content: "x".repeat(MAX_CHILD_FOLLOW_UP_PROMPT_CHARS + 1),
        })
      );
      const blankBody = (await blank.json()) as { error: string };
      const oversizedBody = (await oversized.json()) as { error: string };

      expect(blank.status).toBe(400);
      expect(oversized.status).toBe(400);
      expect(blankBody.error).toMatch(/^Invalid prompt body: .+/);
      expect(oversizedBody.error).toMatch(/^Invalid prompt body: .+/);
      expect(blankBody.error).not.toBe(oversizedBody.error);
    });

    it("returns 404 when the authoritative parent does not match", async () => {
      const { handler, getSession, repository, enqueuePrompt } = createHandler();
      getSession.mockReturnValue(createSession({ parent_session_id: "actual-parent" }));
      repository.listParticipants.mockReturnValue([createParticipant()]);

      const response = await handler.parentPrompt(
        request({ parentSessionId: "wrong-parent", content: "Continue" })
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "Child session not found" });
      expect(enqueuePrompt).not.toHaveBeenCalled();
    });

    it.each(["cancelled", "archived"] as const)(
      "rejects a %s child without storing a prompt",
      async (status) => {
        const { handler, getSession, repository, enqueuePrompt } = createHandler();
        getSession.mockReturnValue(createSession({ parent_session_id: "parent-1", status }));
        repository.listParticipants.mockReturnValue([createParticipant()]);

        const response = await handler.parentPrompt(
          request({ parentSessionId: "parent-1", content: "Continue" })
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
          error: `Cannot prompt a ${status} session`,
        });
        expect(enqueuePrompt).not.toHaveBeenCalled();
      }
    );

    it("rejects a follow-up when the child queue is full", async () => {
      const { handler, getSession, repository, enqueuePrompt } = createHandler();
      getSession.mockReturnValue(createSession({ parent_session_id: "parent-1" }));
      repository.listParticipants.mockReturnValue([createParticipant()]);
      enqueuePrompt.mockRejectedValue(new PromptQueueFullError());

      const response = await handler.parentPrompt(
        request({ parentSessionId: "parent-1", content: "Continue" })
      );

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({ error: "Child prompt queue is full" });
      expect(enqueuePrompt).toHaveBeenCalledOnce();
    });

    it("maps a promptability race to 409", async () => {
      const { handler, getSession, repository, enqueuePrompt } = createHandler();
      getSession.mockReturnValue(createSession({ parent_session_id: "parent-1" }));
      repository.listParticipants.mockReturnValue([createParticipant()]);
      enqueuePrompt.mockRejectedValue(new SessionNotPromptableError("archived"));

      const response = await handler.parentPrompt(
        request({ parentSessionId: "parent-1", content: "Continue" })
      );

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "Cannot prompt a archived session",
      });
    });
  });

  it("returns 404 when session is missing for spawn context", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Session not found" });
  });

  it("returns 401 when the processing prompt author is missing", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession());
    repository.getParticipantById.mockReturnValue(null);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Prompt author not found" });
  });

  it("maps spawn attribution from the processing prompt author instead of the owner", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession());
    repository.listParticipants.mockReturnValue([
      createParticipant(),
      createParticipant({
        id: "participant-2",
        user_id: "slack:U2",
        canonical_user_id: "canonical-2",
        scm_user_id: "222",
        scm_login: "second-user",
        scm_name: "Second User",
        scm_email: "second@example.com",
        role: "member",
        scm_access_token_encrypted: "second-access",
        scm_refresh_token_encrypted: "second-refresh",
        scm_token_expires_at: 5678,
      }),
    ]);
    repository.getProcessingMessageAuthor.mockReturnValue({ author_id: "participant-2" });
    repository.getParticipantById.mockReturnValue(
      createParticipant({
        id: "participant-2",
        user_id: "slack:U2",
        canonical_user_id: "canonical-2",
        role: "member",
        scm_user_id: "222",
        scm_login: "second-user",
        scm_name: "Second User",
        scm_email: "second@example.com",
        scm_access_token_encrypted: "second-access",
        scm_refresh_token_encrypted: "second-refresh",
        scm_token_expires_at: 5678,
      })
    );

    const response = handler.getSpawnContext();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      promptAuthor: {
        userId: "slack:U2",
        canonicalUserId: "canonical-2",
        scmUserId: "222",
        scmLogin: "second-user",
        scmAccessTokenEncrypted: "second-access",
      },
    });
  });

  it("returns a narrow active prompt author without encrypted credentials", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession());
    repository.getParticipantById.mockReturnValue(
      createParticipant({
        user_id: "slack:U2",
        canonical_user_id: "canonical-2",
        scm_user_id: "222",
        scm_login: "second-user",
        scm_name: "Second User",
        scm_email: "second@example.com",
        scm_access_token_encrypted: "secret-access",
        scm_refresh_token_encrypted: "secret-refresh",
      })
    );

    const response = handler.getActivePromptAuthor();

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      userId: "slack:U2",
      canonicalUserId: "canonical-2",
      scmUserId: "222",
      scmLogin: "second-user",
    });
    expect(body).not.toHaveProperty("scmAccessTokenEncrypted");
    expect(body).not.toHaveProperty("scmRefreshTokenEncrypted");
  });

  it("rejects spawn context when no prompt is processing", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(createSession());
    repository.getProcessingMessageAuthor.mockReturnValue(null);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(400);
    expect(repository.getParticipantById).not.toHaveBeenCalled();
  });

  it("maps spawn context from session and processing prompt author", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(
      createSession({
        reasoning_effort: "high",
        sandbox_settings: '{"sandboxTimeoutMs":14400000,"tunnelPorts":[3000]}',
      })
    );
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
      sandboxTimeoutMs: 14_400_000,
      promptAuthor: {
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

  it("maps repo-less spawn context from session and processing prompt author", async () => {
    const { handler, getSession, repository } = createHandler();
    getSession.mockReturnValue(
      createSession({
        repo_owner: null,
        repo_name: null,
        repo_id: null,
        base_branch: null,
      })
    );
    repository.listParticipants.mockReturnValue([createParticipant()]);

    const response = handler.getSpawnContext();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoOwner: null,
      repoName: null,
      repoId: null,
      baseBranch: null,
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
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());
    getPublicSessionId.mockReturnValue("public-session-1");

    artifactRepository.listArtifacts.mockReturnValue([
      createArtifact({ type: "pr", metadata: '{"number":42}' }),
      createArtifact({ type: "preview", metadata: null }),
    ]);
    repository.listEventPage.mockReturnValue({
      hasMore: false,
      nextCursor: null,
      events: [
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
      ],
    });

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
      hasUnfinishedPrompt: false,
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
    expect(repository.listEventPage).toHaveBeenCalledWith({ limit: 50 });
    expect(repository.getLatestTerminalMessage).not.toHaveBeenCalled();
  });

  it("includes final response when requested", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession({ status: "completed" }));
    getSandbox.mockReturnValue(createSandbox({ status: "stopped" }));
    getPublicSessionId.mockReturnValue("public-session-1");
    artifactRepository.listArtifacts.mockReturnValue([
      createArtifact({
        type: "branch",
        url: "https://example.com/tree/fix",
        metadata: '{"head":"fix"}',
      }),
    ]);
    repository.getLatestTerminalMessage.mockReturnValue(createMessage({ id: "msg-final" }));
    repository.listEventPage
      .mockReturnValueOnce({ events: [], hasMore: false, nextCursor: null })
      .mockReturnValueOnce({
        hasMore: false,
        nextCursor: null,
        events: [
          createEvent({
            id: "token:msg-final",
            type: "token",
            message_id: "msg-final",
            data: '{"content":"Final answer from child"}',
            created_at: 10,
          }),
          createEvent({
            id: "exec:msg-final",
            type: "execution_complete",
            message_id: "msg-final",
            data: '{"success":true}',
            created_at: 11,
          }),
          createEvent({
            id: "tool:msg-final",
            type: "tool_call",
            message_id: "msg-final",
            data: '{"tool":"Bash","args":{"command":"npm test"}}',
            created_at: 9,
          }),
        ],
      });

    const response = handler.getChildSummary(
      new URL("http://internal/internal/child-summary?include=result")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      finalResponse: {
        messageId: "msg-final",
        completedAt: 3,
        eventCount: 3,
        eventLimitReached: false,
        textContent: "Final answer from child",
        success: true,
        toolCalls: [{ tool: "Bash", summary: "Ran: npm test" }],
        artifacts: [
          {
            type: "branch",
            url: "https://example.com/tree/fix",
            label: "Branch: fix",
            metadata: { head: "fix" },
          },
        ],
      },
    });
    expect(repository.listEventPage).toHaveBeenNthCalledWith(1, { limit: 50 });
    expect(repository.listEventPage).toHaveBeenNthCalledWith(2, {
      limit: 200,
      messageId: "msg-final",
    });
  });

  it("scopes final response artifacts to the terminal message window", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession({ status: "completed" }));
    getSandbox.mockReturnValue(createSandbox({ status: "stopped" }));
    getPublicSessionId.mockReturnValue("public-session-1");
    artifactRepository.listArtifacts.mockReturnValue([
      createArtifact({
        id: "artifact-old",
        type: "branch",
        url: "https://example.com/tree/old",
        metadata: '{"head":"old"}',
        created_at: 10,
      }),
      createArtifact({
        id: "artifact-current",
        type: "branch",
        url: "https://example.com/tree/current",
        metadata: '{"head":"current"}',
        created_at: 30,
      }),
    ]);
    repository.getLatestTerminalMessage.mockReturnValue(
      createMessage({
        id: "msg-current",
        created_at: 20,
        started_at: 25,
        completed_at: 40,
      })
    );
    repository.listEventPage
      .mockReturnValueOnce({ events: [], hasMore: false, nextCursor: null })
      .mockReturnValueOnce({
        hasMore: false,
        nextCursor: null,
        events: [
          createEvent({
            id: "token:msg-current",
            type: "token",
            message_id: "msg-current",
            data: '{"content":"Current answer"}',
            created_at: 35,
          }),
        ],
      });

    const response = handler.getChildSummary(
      new URL("http://internal/internal/child-summary?include=result")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      finalResponse: {
        artifacts: [
          {
            type: "branch",
            url: "https://example.com/tree/current",
            label: "Branch: current",
            metadata: { head: "current" },
          },
        ],
      },
    });
  });

  it("paginates final response events when requested", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession({ status: "completed" }));
    getSandbox.mockReturnValue(createSandbox({ status: "stopped" }));
    getPublicSessionId.mockReturnValue("public-session-1");
    artifactRepository.listArtifacts.mockReturnValue([]);
    repository.getLatestTerminalMessage.mockReturnValue(createMessage({ id: "msg-final" }));
    repository.listEventPage
      .mockReturnValueOnce({ events: [], hasMore: false, nextCursor: null })
      .mockReturnValueOnce({
        hasMore: true,
        nextCursor: { kind: "timeline", createdAt: 20, id: "token:new" },
        events: [
          createEvent({
            id: "token:new",
            type: "token",
            message_id: "msg-final",
            data: '{"content":"done"}',
            created_at: 20,
          }),
        ],
      })
      .mockReturnValueOnce({
        hasMore: false,
        nextCursor: null,
        events: [
          createEvent({
            id: "tool:old",
            type: "tool_call",
            message_id: "msg-final",
            data: '{"tool":"Bash","args":{"command":"npm test"}}',
            created_at: 10,
          }),
        ],
      });

    const response = handler.getChildSummary(
      new URL("http://internal/internal/child-summary?include=result")
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      finalResponse: {
        textContent: "done",
        eventCount: 2,
        eventLimitReached: false,
        toolCalls: [{ tool: "Bash", summary: "Ran: npm test" }],
      },
    });
    expect(repository.listEventPage).toHaveBeenNthCalledWith(2, {
      limit: FINAL_RESPONSE_EVENT_PAGE_LIMIT,
      messageId: "msg-final",
    });
    expect(repository.listEventPage).toHaveBeenNthCalledWith(3, {
      limit: FINAL_RESPONSE_EVENT_PAGE_LIMIT,
      messageId: "msg-final",
      cursor: { kind: "timeline", createdAt: 20, id: "token:new" },
    });
  });

  it("marks final response event collection as limited at the explicit cap", () => {
    const pageRows = Array.from({ length: FINAL_RESPONSE_EVENT_PAGE_LIMIT }, (_, index) =>
      createEvent({
        id: `event-${index}`,
        message_id: "msg-final",
        created_at: FINAL_RESPONSE_MAX_EVENTS - index,
      })
    );
    const source = {
      listEventPage: vi.fn().mockReturnValue({
        events: pageRows,
        hasMore: true,
        nextCursor: { kind: "timeline", createdAt: 801, id: "event-199" },
      }),
    };

    const result = collectFinalResponseEventRows(source, "msg-final");

    expect(result.eventRows).toHaveLength(FINAL_RESPONSE_MAX_EVENTS);
    expect(result.eventLimitReached).toBe(true);
    expect(source.listEventPage).toHaveBeenCalledTimes(
      FINAL_RESPONSE_MAX_EVENTS / FINAL_RESPONSE_EVENT_PAGE_LIMIT
    );
  });

  it("includes chronological trajectory when requested", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());
    getPublicSessionId.mockReturnValue("public-session-1");
    artifactRepository.listArtifacts.mockReturnValue([]);
    repository.getLatestTerminalMessage.mockReturnValue(null);
    repository.listEventPage.mockReturnValueOnce({ events: [], hasMore: false, nextCursor: null });
    repository.getEventTimelinePage.mockReturnValue({
      events: [
        createEvent({ id: "e1", type: "tool_call", data: '{"tool":"Read"}', created_at: 10 }),
        createEvent({ id: "e2", type: "tool_result", data: '{"result":"ok"}', created_at: 20 }),
      ],
      hasMore: false,
      nextCursor: null,
    });

    const response = handler.getChildSummary(
      new URL("http://internal/internal/child-summary?include=trajectory")
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("finalResponse");
    expect(body).toMatchObject({
      trajectory: {
        hasMore: false,
        limit: 200,
        events: [
          { id: "e1", type: "tool_call", data: { tool: "Read" }, createdAt: 10 },
          { id: "e2", type: "tool_result", data: { result: "ok" }, createdAt: 20 },
        ],
      },
    });
    expect(repository.listEventPage).toHaveBeenNthCalledWith(1, { limit: 50 });
    expect(repository.getEventTimelinePage).toHaveBeenCalledWith({
      limit: 200,
      cursor: undefined,
    });
    expect(repository.getLatestTerminalMessage).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed trajectory cursors", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());
    getPublicSessionId.mockReturnValue("public-session-1");

    const response = handler.getChildSummary(
      new URL("http://internal/internal/child-summary?include=trajectory&trajectoryCursor=bad")
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid trajectoryCursor" });
    expect(artifactRepository.listArtifacts).not.toHaveBeenCalled();
    expect(repository.getEventTimelinePage).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "abc", "1.5"])(
    "returns 400 for invalid trajectory limits (%s)",
    async (trajectoryLimit) => {
      const {
        handler,
        getSession,
        getSandbox,
        getPublicSessionId,
        repository,
        artifactRepository,
      } = createHandler();
      getSession.mockReturnValue(createSession());
      getSandbox.mockReturnValue(createSandbox());
      getPublicSessionId.mockReturnValue("public-session-1");

      const response = handler.getChildSummary(
        new URL(
          `http://internal/internal/child-summary?include=trajectory&trajectoryLimit=${trajectoryLimit}`
        )
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid trajectoryLimit" });
      expect(artifactRepository.listArtifacts).not.toHaveBeenCalled();
      expect(repository.getEventTimelinePage).not.toHaveBeenCalled();
    }
  );

  it("returns 400 for invalid child summary includes", async () => {
    const { handler, getSession, repository, artifactRepository } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = handler.getChildSummary(
      new URL("http://internal/internal/child-summary?include=result&include=unknown")
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid include: unknown" });
    expect(artifactRepository.listArtifacts).not.toHaveBeenCalled();
    expect(repository.listEventPage).not.toHaveBeenCalled();
  });

  it("paginates trajectory with an explicit limit and cursor", async () => {
    const { handler, getSession, getSandbox, getPublicSessionId, repository, artifactRepository } =
      createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());
    getPublicSessionId.mockReturnValue("public-session-1");
    artifactRepository.listArtifacts.mockReturnValue([]);
    repository.getLatestTerminalMessage.mockReturnValue(null);
    repository.listEventPage.mockReturnValueOnce({ events: [], hasMore: false, nextCursor: null });
    repository.getEventTimelinePage.mockReturnValue({
      events: [
        createEvent({
          id: "token:msg-final",
          type: "token",
          data: '{"content":"new"}',
          created_at: 30,
        }),
      ],
      hasMore: true,
      nextCursor: { kind: "timeline", createdAt: 30, id: "token:msg-final" },
    });

    const response = handler.getChildSummary(
      new URL(
        "http://internal/internal/child-summary?include=trajectory&trajectoryLimit=1&trajectoryCursor=40:cursor-id"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      trajectory: {
        hasMore: true,
        cursor: "30:token%3Amsg-final",
        limit: 1,
        events: [
          {
            id: "token:msg-final",
            type: "token",
            data: { content: "new" },
            createdAt: 30,
          },
        ],
      },
    });
    expect(repository.getEventTimelinePage).toHaveBeenCalledWith({
      limit: 1,
      cursor: { kind: "timeline", createdAt: 40, id: "cursor-id" },
    });
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

  it("returns 400 when child session update body is malformed JSON", async () => {
    const { handler, broadcast } = createHandler();

    const response = await handler.childSessionUpdate(
      new Request("http://internal/internal/child-session/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"childSessionId":',
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "childSessionId and status are required" });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("returns 400 when child session update status is invalid", async () => {
    const { handler, broadcast } = createHandler();

    const response = await handler.childSessionUpdate(
      new Request("http://internal/internal/child-session/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ childSessionId: "child-1", status: "paused", title: null }),
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

  it("broadcasts child session update when title is null", async () => {
    const { handler, broadcast } = createHandler();

    const response = await handler.childSessionUpdate(
      new Request("http://internal/internal/child-session/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          childSessionId: "child-1",
          status: "active",
          title: null,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith({
      type: "child_session_update",
      childSessionId: "child-1",
      status: "active",
      title: null,
    });
  });
});
