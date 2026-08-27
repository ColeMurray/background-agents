import { describe, expect, it, vi } from "vitest";
import { MAX_CHILD_FOLLOW_UP_PROMPT_CHARS } from "@open-inspect/shared/types/session-api";
import { ChildSessionsHandler } from "./child-sessions.handler";
import { PromptQueueFullError, SessionNotPromptableError } from "../../message-queue";
import type { ParticipantRow, SessionRow } from "../../types";
import type { ParticipantRepository } from "../../participant-repository";
import type { MessageRepository } from "../../message-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "public-session-1",
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

function createHandler() {
  const repository = {
    listParticipants: vi.fn(),
    getProcessingMessageAuthor: vi.fn<() => { author_id: string } | null>(() => ({
      author_id: "participant-1",
    })),
    getParticipantById: vi.fn<(id: string) => ParticipantRow | null>(() => createParticipant()),
  };
  const getSession = vi.fn<() => SessionRow | null>();
  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const enqueuePrompt = vi.fn(async () => ({
    messageId: "message-follow-up",
    status: "queued" as const,
  }));
  const messageService = { enqueuePrompt };

  const handler = new ChildSessionsHandler(
    repository as unknown as MessageRepository,
    repository as unknown as ParticipantRepository,
    { getSession } as unknown as SessionCoreRepository,
    messenger,
    messageService
  );

  return {
    handler,
    repository,
    getSession,
    broadcast,
    enqueuePrompt,
  };
}

describe("ChildSessionsHandler", () => {
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
