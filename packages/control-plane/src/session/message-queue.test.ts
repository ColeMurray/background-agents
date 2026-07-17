import { describe, expect, it, vi } from "vitest";
import { SessionMessageQueue } from "./message-queue";
import { AttachmentClaimConflictError } from "./session-attachment-repository";
import type { ClientInfo, Env, ServerMessage } from "../types";
import type { MessageRow, ParticipantRow, SessionRow, SessionAttachmentRow } from "./types";

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "part-1",
    user_id: "user-1",
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: null,
    scm_name: "Octo Cat",
    auth_name: null,
    role: "member",
    scm_access_token_encrypted: null,
    scm_refresh_token_encrypted: null,
    scm_token_expires_at: null,
    ws_auth_token: null,
    ws_token_created_at: null,
    joined_at: 1000,
    ...overrides,
  };
}

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "sess-1",
    session_name: "s1",
    title: "Session",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 1,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function createMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    author_id: "part-1",
    content: "hello",
    source: "web",
    model: null,
    reasoning_effort: null,
    attachments: null,
    callback_context: null,
    status: "pending",
    error_message: null,
    created_at: 1000,
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function createClientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    participantId: "part-1",
    userId: "user-1",
    name: "User",
    status: "active",
    lastSeen: 1000,
    clientId: "client-1",
    ws: {} as WebSocket,
    ...overrides,
  };
}

function buildQueue(options?: { getClientInfo?: (ws: WebSocket) => ClientInfo | null }) {
  const repository = {
    createMessageWithAttachments: vi.fn(),
    createEvent: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 1),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    getNextPendingMessage: vi.fn(() => null as MessageRow | null),
    updateMessageToProcessing: vi.fn(),
    getParticipantById: vi.fn(() => createParticipant()),
    updateParticipantCoalesce: vi.fn(),
    replaceParticipantScmEnrichment: vi.fn(),
    updateMessageCompletion: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
  };

  const attachmentRepository = {
    getUnreferenced: vi.fn((): SessionAttachmentRow[] => []),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn((_ws: WebSocket, _message: ServerMessage) => true),
  };

  const participantService = {
    getByUserId: vi.fn(() => createParticipant()),
    create: vi.fn((userId: string, _name: string) => createParticipant({ user_id: userId })),
  };

  const callbackService = {
    notifyComplete: vi.fn(async () => {}),
    notifyStarted: vi.fn(async () => {}),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const spawnSandbox = vi.fn(async () => {});
  const setSessionStatus = vi.fn(async (_status: string) => {});
  const reconcileSessionStatusAfterExecution = vi.fn(async (_success: boolean) => {});
  const updateLastActivity = vi.fn();
  const waitUntil = vi.fn();

  const queue = new SessionMessageQueue({
    env: {} as Env,
    ctx: { waitUntil } as unknown as DurableObjectState,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    },
    repository: repository as never,
    attachmentRepository: attachmentRepository as never,
    wsManager: wsManager as never,
    participantService: participantService as never,
    callbackService: callbackService as never,
    scmProvider: "github",
    getClientInfo: options?.getClientInfo ?? (() => createClientInfo()),
    validateReasoningEffort: vi.fn(() => null),
    getSession: vi.fn(() => createSession()),
    updateLastActivity,
    spawnSandbox,
    broadcast,
    setSessionStatus,
    reconcileSessionStatusAfterExecution,
  });

  return {
    queue,
    repository,
    attachmentRepository,
    wsManager,
    participantService,
    broadcast,
    spawnSandbox,
    setSessionStatus,
    reconcileSessionStatusAfterExecution,
    waitUntil,
    callbackService,
  };
}

describe("SessionMessageQueue", () => {
  it("sends NOT_SUBSCRIBED when prompt arrives before subscribe", async () => {
    const h = buildQueue({ getClientInfo: () => null });

    await h.queue.handlePromptMessage({} as WebSocket, { content: "hello" });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "NOT_SUBSCRIBED" })
    );
    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.setSessionStatus).not.toHaveBeenCalled();
  });

  it("spawns sandbox when queue has work but no sandbox socket", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());

    await h.queue.processMessageQueue();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_spawning" });
    expect(h.spawnSandbox).toHaveBeenCalledTimes(1);
    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
    expect(h.callbackService.notifyStarted).not.toHaveBeenCalled();
  });

  it("marks session active when a prompt is enqueued", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, { content: "hello" });

    expect(h.setSessionStatus).toHaveBeenCalledWith("active");
  });

  it("stores attachments and embeds content-free metadata in the user_message event", async () => {
    const h = buildQueue();
    h.attachmentRepository.getUnreferenced.mockReturnValue([
      {
        id: "up-1",
        mime_type: "image/png",
        size_bytes: 100,
        object_key: "sessions/sess-1/attachments/up-1",
        message_id: null,
        cleanup_claimed_at: null,
        created_at: 1,
      },
    ]);

    await h.queue.handlePromptMessage({} as WebSocket, {
      content: "look at this",
      attachments: [
        {
          name: "shot.png",
          attachmentId: "up-1",
        },
      ],
    });

    expect(h.repository.createMessageWithAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: JSON.stringify([
          { name: "shot.png", attachmentId: "up-1", mimeType: "image/png" },
        ]),
      }),
      ["up-1"]
    );

    expect(h.broadcast).toHaveBeenCalledWith({
      type: "sandbox_event",
      event: expect.objectContaining({
        type: "user_message",
        attachments: [{ name: "shot.png", mimeType: "image/png", attachmentId: "up-1" }],
      }),
    });
    const storedEvent = JSON.parse(h.repository.createEvent.mock.calls[0][0].data as string);
    expect(storedEvent.attachments).toEqual([
      { name: "shot.png", mimeType: "image/png", attachmentId: "up-1" },
    ]);
  });

  it("rejects a prompt when its upload loses the atomic claim race", async () => {
    const h = buildQueue();
    h.attachmentRepository.getUnreferenced.mockReturnValue([
      {
        id: "up-1",
        mime_type: "image/png",
        size_bytes: 100,
        object_key: "sessions/sess-1/attachments/up-1",
        message_id: null,
        cleanup_claimed_at: null,
        created_at: 1,
      },
    ]);
    h.repository.createMessageWithAttachments.mockImplementation(() => {
      throw new AttachmentClaimConflictError("already claimed");
    });

    await h.queue.handlePromptMessage({} as WebSocket, {
      content: "look",
      attachments: [{ name: "shot.png", attachmentId: "up-1" }],
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "INVALID_ATTACHMENTS" })
    );
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.setSessionStatus).not.toHaveBeenCalled();
  });

  it("rejects upload references that cannot be claimed", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, {
      content: "look",
      attachments: [{ name: "missing.png", attachmentId: "missing" }],
    });

    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "INVALID_ATTACHMENTS" })
    );
  });

  it("does not disguise attachment storage failures as invalid user input", async () => {
    const h = buildQueue();
    h.attachmentRepository.getUnreferenced.mockImplementation(() => {
      throw new Error("database unavailable");
    });

    await expect(
      h.queue.handlePromptMessage({} as WebSocket, {
        content: "look",
        attachments: [{ name: "shot.png", attachmentId: "up-1" }],
      })
    ).rejects.toThrow("database unavailable");

    expect(h.wsManager.send).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "INVALID_ATTACHMENTS" })
    );
  });

  it("rejects attachment rows with unsupported image metadata", async () => {
    const h = buildQueue();
    h.attachmentRepository.getUnreferenced.mockReturnValue([
      {
        id: "up-invalid",
        mime_type: "application/pdf",
        size_bytes: 100,
        object_key: "sessions/sess-1/attachments/up-invalid",
        message_id: null,
        cleanup_claimed_at: null,
        created_at: 1,
      },
    ]);

    await h.queue.handlePromptMessage({} as WebSocket, {
      content: "watch this",
      attachments: [{ name: "document.pdf", attachmentId: "up-invalid" }],
    });

    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        code: "INVALID_ATTACHMENTS",
        message: "Attachment is not a supported image",
      })
    );
  });

  it("omits attachments from the user_message event when none are sent", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, { content: "hello" });

    const broadcastCall = h.broadcast.mock.calls.find(
      ([message]) =>
        (message as { type: string; event?: { type?: string } }).type === "sandbox_event" &&
        (message as { event?: { type?: string } }).event?.type === "user_message"
    );
    expect(broadcastCall).toBeDefined();
    expect((broadcastCall?.[0] as { event: Record<string, unknown> }).event).not.toHaveProperty(
      "attachments"
    );
  });

  it("uses the provider-agnostic auth name for user messages without SCM identity", () => {
    const h = buildQueue();
    const participant = createParticipant({
      scm_name: null,
      scm_login: null,
      auth_name: "Pat PM",
    });

    h.queue.writeUserMessageEvent(participant, "hello", "msg-1", 1000);

    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sandbox_event",
        event: expect.objectContaining({
          author: expect.objectContaining({ name: "Pat PM" }),
        }),
      })
    );
  });

  it("dispatches prompt command when sandbox socket exists", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-42" }));
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.repository.updateMessageToProcessing).toHaveBeenCalledWith(
      "msg-42",
      expect.any(Number)
    );
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "prompt", messageId: "msg-42" })
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: true });
  });

  it("derives canonical GitHub author metadata again at sandbox dispatch", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-attributed" }));
    h.repository.getParticipantById.mockReturnValue(
      createParticipant({
        scm_user_id: "1001",
        scm_login: "octocat",
        scm_name: "Octo Cat",
        scm_email: "private@example.com",
      })
    );
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({
        author: {
          userId: "user-1",
          gitIdentity: {
            mode: "attributed-user",
            name: "Octo Cat",
            email: "1001+octocat@users.noreply.github.com",
          },
        },
      })
    );
  });

  it("falls back atomically when GitHub author mapping is incomplete", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-agent-only" }));
    h.repository.getParticipantById.mockReturnValue(
      createParticipant({
        scm_user_id: null,
        scm_login: "octocat",
        scm_name: "Octo Cat",
        scm_email: "private@example.com",
      })
    );
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({
        author: {
          userId: "user-1",
          gitIdentity: { mode: "agent-only" },
        },
      })
    );
  });

  it("uses the current participant identity for each dispatched prompt", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
    h.repository.getNextPendingMessage
      .mockReturnValueOnce(createMessage({ id: "msg-ada", author_id: "part-ada" }))
      .mockReturnValueOnce(createMessage({ id: "msg-grace", author_id: "part-grace" }));
    h.repository.getParticipantById
      .mockReturnValueOnce(
        createParticipant({
          id: "part-ada",
          user_id: "user-ada",
          scm_user_id: "1001",
          scm_login: "ada",
          scm_name: "Ada Lovelace",
        })
      )
      .mockReturnValueOnce(
        createParticipant({
          id: "part-grace",
          user_id: "user-grace",
          scm_user_id: "1002",
          scm_login: "grace",
          scm_name: "Grace Hopper",
        })
      );

    await h.queue.processMessageQueue();
    await h.queue.processMessageQueue();

    expect(h.wsManager.send.mock.calls.map(([, command]) => command)).toEqual([
      expect.objectContaining({
        author: {
          userId: "user-ada",
          gitIdentity: {
            mode: "attributed-user",
            name: "Ada Lovelace",
            email: "1001+ada@users.noreply.github.com",
          },
        },
      }),
      expect.objectContaining({
        author: {
          userId: "user-grace",
          gitIdentity: {
            mode: "attributed-user",
            name: "Grace Hopper",
            email: "1002+grace@users.noreply.github.com",
          },
        },
      }),
    ]);
  });

  it("notifies the integration after a prompt is dispatched to the sandbox", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-linear" }));
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.callbackService.notifyStarted).toHaveBeenCalledWith("msg-linear");
    expect(h.waitUntil).toHaveBeenCalledOnce();
  });

  it("does not notify the integration when sandbox dispatch fails", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-failed" }));
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);
    h.wsManager.send.mockReturnValue(false);

    await h.queue.processMessageQueue();

    expect(h.callbackService.notifyStarted).not.toHaveBeenCalled();
    expect(h.waitUntil).not.toHaveBeenCalled();
  });

  it("marks processing message failed and broadcasts synthetic completion on stop", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-9" });
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.stopExecution();

    expect(h.repository.updateMessageCompletion).toHaveBeenCalledWith(
      "msg-9",
      "failed",
      expect.any(Number)
    );
    expect(h.repository.upsertExecutionCompleteEvent).toHaveBeenCalledWith(
      "msg-9",
      expect.objectContaining({ type: "execution_complete", success: false }),
      expect.any(Number)
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "stop" });
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(false);
  });

  it("suppresses session status reconcile when stopExecution is called with suppress flag", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-10" });

    await h.queue.stopExecution({ suppressStatusReconcile: true });

    expect(h.reconcileSessionStatusAfterExecution).not.toHaveBeenCalled();
  });

  it("reconciles session status when failing a stuck processing message", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-timeout" });

    await h.queue.failStuckProcessingMessage();

    expect(h.reconcileSessionStatusAfterExecution).toHaveBeenCalledWith(false);
  });

  describe("enqueuePromptFromApi", () => {
    it("creates participant with the enriched identity name when new", async () => {
      const h = buildQueue();
      h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
        scmEnrichment: {
          userId: "1001",
          login: "octocat",
          name: "Octo Cat",
          email: "1001+octocat@users.noreply.github.com",
          accessTokenEncrypted: null,
          refreshTokenEncrypted: null,
          tokenExpiresAt: null,
        },
      });

      expect(h.participantService.create).toHaveBeenCalledWith("github:1001", "Octo Cat");
    });

    it("uses authorId as display name when identity enrichment is missing", async () => {
      const h = buildQueue();
      h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
      });

      expect(h.participantService.create).toHaveBeenCalledWith("github:1001", "github:1001");
    });

    it("replaces stored SCM identity and tokens with one trusted enrichment snapshot", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
        scmEnrichment: {
          userId: "1001",
          login: "octocat",
          name: "Trusted Octo Cat",
          email: "1001+octocat@users.noreply.github.com",
          accessTokenEncrypted: "enc-access",
          refreshTokenEncrypted: "enc-refresh",
          tokenExpiresAt: 9999999,
        },
      });

      expect(h.repository.replaceParticipantScmEnrichment).toHaveBeenCalledWith("part-1", {
        scmName: "Trusted Octo Cat",
        scmEmail: "1001+octocat@users.noreply.github.com",
        scmLogin: "octocat",
        scmUserId: "1001",
        scmAccessTokenEncrypted: "enc-access",
        scmRefreshTokenEncrypted: "enc-refresh",
        scmTokenExpiresAt: 9999999,
      });
      expect(h.repository.updateParticipantCoalesce).not.toHaveBeenCalled();
    });

    it("clears the complete SCM enrichment snapshot after confirmed absence", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
        scmEnrichment: null,
      });

      expect(h.repository.replaceParticipantScmEnrichment).toHaveBeenCalledWith("part-1", {
        scmName: null,
        scmEmail: null,
        scmLogin: null,
        scmUserId: null,
        scmAccessTokenEncrypted: null,
        scmRefreshTokenEncrypted: null,
        scmTokenExpiresAt: null,
      });
      expect(h.repository.updateParticipantCoalesce).not.toHaveBeenCalled();
    });

    it("leaves stored enrichment unchanged when no snapshot is provided", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github-bot",
      });

      expect(h.repository.replaceParticipantScmEnrichment).not.toHaveBeenCalled();
      expect(h.repository.updateParticipantCoalesce).not.toHaveBeenCalled();
    });
  });
});
