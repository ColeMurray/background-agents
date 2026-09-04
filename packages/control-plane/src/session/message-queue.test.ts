import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { fingerprintWebPrompt, SessionMessageQueue } from "./message-queue";
import { AttachmentClaimConflictError } from "./session-attachment-repository";
import type { SessionAttachmentRepository } from "./session-attachment-repository";
import {
  serverMessageSchema,
  type ServerMessage,
} from "@open-inspect/shared/types/server-messages";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import type { ClientInfo } from "../types";
import type { MessageRow, ParticipantRow, SessionRow, SessionAttachmentRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { ParticipantRepository } from "./participant-repository";
import type { MessageRepository } from "./message-repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import { createEarliestAlarmScheduler } from "./alarm/scheduler";
import type { SessionStatusService } from "./session-status-service";
import type { GitHubAutofixSessionCommand } from "@open-inspect/shared";

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
    vnc_enabled: 0,
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
    client_request_id: null,
    request_fingerprint: null,
    autofix_feedback_key: null,
    autofix_pr_key: null,
    origin_context: null,
    status: "pending",
    error_message: null,
    stop_confirmation_deadline: null,
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
    authorizationExpiresAt: Date.now() + 300_000,
    ...overrides,
  };
}

const EXECUTION_TIMEOUT_MS = 60_000;

it("creates a canonical SHA-256 web prompt fingerprint", async () => {
  const fingerprint = await fingerprintWebPrompt("part-1", {
    content: "hello",
    model: "anthropic/claude-haiku-4-5",
    attachments: [{ name: "ignored-name.png", attachmentId: "up-1" }],
  });

  expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  await expect(
    fingerprintWebPrompt("part-1", {
      content: "hello",
      model: "anthropic/claude-haiku-4-5",
      attachments: [{ name: "different-name.png", attachmentId: "up-1" }],
    })
  ).resolves.toBe(fingerprint);
});

function buildQueue() {
  // Mutable so tests can pin that the deadline honors the value current at
  // dispatch time — the thunk exists because settings can be persisted after
  // the queue is constructed.
  let executionTimeoutMs = EXECUTION_TIMEOUT_MS;
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const repository = {
    createMessageWithAttachments: vi.fn(),
    createEvent: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 1),
    getMessageByClientRequestId: vi.fn(() => null as MessageRow | null),
    admitAutofixMessage: vi.fn<MessageRepository["admitAutofixMessage"]>(() => ({
      kind: "enqueued",
      messageId: "msg-autofix",
    })),
    getAutofixMessageId: vi.fn(() => null as string | null),
    getMessageStatus: vi.fn(() => "pending" as const),
    cancelPendingMessage: vi.fn(() => false),
    getUnfinishedMessagePosition: vi.fn((): number | null => 1),
    listUnfinishedMessages: vi.fn((): MessageRow[] => []),
    listPromptQueue: vi.fn(() => []),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    getMessageAwaitingStopConfirmation: vi.fn(
      () => null as { id: string; deadline: number } | null
    ),
    clearMessageAwaitingStopConfirmation: vi.fn(),
    getProcessingMessageWithCreatedAt: vi.fn(
      () => null as { id: string; created_at: number } | null
    ),
    getNextPendingMessage: vi.fn(() => null as MessageRow | null),
    startMessageProcessing: vi.fn<MessageRepository["startMessageProcessing"]>(() => true),
    updateMessageToProcessing: vi.fn(),
    updateMessageToPending: vi.fn(),
    getParticipantById: vi.fn(() => createParticipant()),
    getSession: vi.fn(() => createSession()),
    updateParticipantCoalesce: vi.fn(),
    recordMessageCompletion: vi.fn((event: { messageId: string }, completedAt: number) => ({
      messageId: event.messageId,
      messageCreatedAt: 1000,
      messageStartedAt: 1100,
      completedAt,
      status: "failed" as const,
    })),
    markMessageAwaitingStopConfirmation: vi.fn(),
    listPendingMessagesWithCreatedAt: vi.fn((): Array<{ id: string; created_at: number }> => []),
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
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const sessionStatus = {
    transition: vi.fn(async (_status: string) => true),
    reconcileAfterExecution: vi.fn(async (_success: boolean) => {}),
    reconcileAfterQueueRemoval: vi.fn(async () => {}),
  };
  const sandboxLifecycle = {
    spawnSandbox: vi.fn(async () => {}),
    updateLastActivity: vi.fn((_timestamp: number) => {}),
    terminateUnresponsiveSandbox: vi.fn(async () => {}),
    terminateFailedSandbox: vi.fn(async () => true),
    reportSandboxError: vi.fn((_reason: string) => {}),
  };
  const backgroundTasks = createTestBackgroundTasks();
  const getAlarm = vi.fn(async () => null as number | null);
  const setAlarm = vi.fn(async (_timestamp: number) => {});
  const projectTerminalMessage = vi.fn(async () => {});
  const getProviderAuthenticationError = vi.fn(async (_model: string) => null as string | null);

  const queue = new SessionMessageQueue(
    backgroundTasks,
    log,
    repository as unknown as SessionCoreRepository,
    repository as unknown as MessageRepository,
    repository as unknown as ParticipantRepository,
    attachmentRepository as unknown as SessionAttachmentRepository,
    wsManager as unknown as SessionWebSocketManager,
    messenger,
    participantService as unknown as ParticipantService,
    callbackService as unknown as CallbackNotificationService,
    sessionStatus as unknown as SessionStatusService,
    getProviderAuthenticationError,
    projectTerminalMessage,
    sandboxLifecycle,
    null,
    "github",
    createEarliestAlarmScheduler(
      { getAlarm, setAlarm, deleteAlarm: vi.fn(async () => {}) },
      {
        pending: vi.fn(() => null),
        earliest: vi.fn(() => null),
        cancelled: vi.fn(() => false),
        setPending: vi.fn(),
        activate: vi.fn(),
        clear: vi.fn(),
        beginDelivery: vi.fn(() => null),
        completeDelivery: vi.fn(),
      }
    ),
    () => executionTimeoutMs
  );

  return {
    queue,
    repository,
    attachmentRepository,
    wsManager,
    participantService,
    broadcast,
    sessionStatus,
    sandboxLifecycle,
    backgroundTasks,
    getAlarm,
    setAlarm,
    callbackService,
    getProviderAuthenticationError,
    projectTerminalMessage,
    log,
    setExecutionTimeoutMs(value: number) {
      executionTimeoutMs = value;
    },
  };
}

describe("SessionMessageQueue", () => {
  it("admits Autofix feedback through the message repository", async () => {
    const h = buildQueue();
    const command: Extract<GitHubAutofixSessionCommand, { type: "enqueue_feedback" }> = {
      type: "enqueue_feedback",
      feedbackKey: "github:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review",
        authorType: "human",
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: 10,
    };

    await expect(h.queue.enqueueAutofix(command)).resolves.toEqual({
      kind: "enqueued",
      messageId: "msg-autofix",
    });
    expect(h.participantService.getByUserId).toHaveBeenCalledWith("github:7");
    expect(h.repository.updateParticipantCoalesce).toHaveBeenCalledWith("part-1", {
      scmUserId: "7",
      scmLogin: "alice",
      scmName: "alice",
    });
    expect(h.repository.admitAutofixMessage).toHaveBeenCalledWith({
      message: expect.objectContaining({
        authorId: "part-1",
        content: command.prompt,
        source: "github",
        status: "pending",
      }),
      feedbackKey: command.feedbackKey,
      pullRequestKey: "github:99:42",
      originContext: JSON.stringify(command.origin),
      attemptLimit: 10,
      windowStart: expect.any(Number),
      sessionClosed: false,
    });
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.sessionStatus.transition).toHaveBeenCalledWith("active");
    expect(h.broadcast).toHaveBeenCalledWith({ type: "prompt_queue_updated", promptQueue: [] });
  });

  it("re-drives duplicate pending Autofix work without admitting another message", async () => {
    const h = buildQueue();
    h.repository.admitAutofixMessage.mockReturnValue({
      kind: "duplicate",
      messageId: "msg-existing",
    });

    const result = await h.queue.enqueueAutofix({
      type: "enqueue_feedback",
      feedbackKey: "github:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review",
        authorType: "human",
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: 10,
    });

    expect(result).toEqual({ kind: "duplicate", messageId: "msg-existing" });
    expect(h.sessionStatus.transition).toHaveBeenCalledWith("active");
    expect(h.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox_event" })
    );
  });

  it("passes closed-session state into atomic Autofix admission", async () => {
    const h = buildQueue();
    h.repository.getSession.mockReturnValue(createSession({ status: "archived" }));
    h.repository.admitAutofixMessage.mockReturnValue({
      kind: "rejected",
      reason: "session_closed",
    });

    const result = await h.queue.enqueueAutofix({
      type: "enqueue_feedback",
      feedbackKey: "github:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review",
        authorType: "human",
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: 10,
    });

    expect(result).toEqual({ kind: "rejected", reason: "session_closed" });
    expect(h.repository.admitAutofixMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionClosed: true })
    );
    expect(h.sessionStatus.transition).not.toHaveBeenCalled();
  });

  it("returns a duplicate without re-driving it in a closed session", async () => {
    const h = buildQueue();
    h.repository.getSession.mockReturnValue(createSession({ status: "archived" }));
    h.repository.admitAutofixMessage.mockReturnValue({
      kind: "duplicate",
      messageId: "msg-existing",
    });

    const result = await h.queue.enqueueAutofix({
      type: "enqueue_feedback",
      feedbackKey: "github:review:1234",
      pullRequest: { repositoryId: "99", number: 42, artifactId: "artifact-1" },
      prompt: "Address the submitted review feedback.",
      author: { id: "7", login: "alice" },
      origin: {
        kind: "review",
        authorType: "human",
        feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
      },
      attemptLimit: 10,
    });

    expect(result).toEqual({ kind: "duplicate", messageId: "msg-existing" });
    expect(h.sessionStatus.transition).not.toHaveBeenCalled();
    expect(h.repository.getNextPendingMessage).not.toHaveBeenCalled();
  });

  it("looks up and re-drives pending Autofix work", async () => {
    const h = buildQueue();
    h.repository.getAutofixMessageId.mockReturnValue("msg-existing");

    await expect(h.queue.lookupAutofix("github:review:1234")).resolves.toEqual({
      kind: "found",
      messageId: "msg-existing",
    });
    expect(h.sessionStatus.transition).toHaveBeenCalledWith("active");
  });

  it("cancels a pending prompt and confirms it to the requester", async () => {
    const h = buildQueue();
    h.repository.cancelPendingMessage.mockReturnValue(true);
    const ws = {} as WebSocket;

    await h.queue.cancelQueuedPrompt(ws, {
      messageId: "msg-1",
      clientRequestId: "request-1",
    });

    expect(h.repository.cancelPendingMessage).toHaveBeenCalledWith("msg-1");
    expect(h.wsManager.send).toHaveBeenCalledWith(ws, {
      type: "prompt_cancelled",
      clientRequestId: "request-1",
      messageId: "msg-1",
    });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "prompt_queue_updated", promptQueue: [] });
    expect(h.sessionStatus.reconcileAfterQueueRemoval).toHaveBeenCalledOnce();
  });

  it("rejects cancellation after a prompt leaves pending state", async () => {
    const h = buildQueue();
    const ws = {} as WebSocket;

    await h.queue.cancelQueuedPrompt(ws, {
      messageId: "msg-1",
      clientRequestId: "request-1",
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(ws, {
      type: "error",
      code: "PROMPT_NOT_CANCELLABLE",
      message: "This prompt is no longer pending and cannot be removed",
      clientRequestId: "request-1",
    });
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("reconciles session status after removing a prompt", async () => {
    const h = buildQueue();
    h.repository.cancelPendingMessage.mockReturnValue(true);

    await h.queue.cancelQueuedPrompt({} as WebSocket, {
      messageId: "msg-1",
      clientRequestId: "request-1",
    });

    expect(h.sessionStatus.reconcileAfterQueueRemoval).toHaveBeenCalledOnce();
  });

  it("spawns sandbox when queue has work but no sandbox socket", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());

    await h.queue.processMessageQueue();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_spawning" });
    expect(h.sandboxLifecycle.spawnSandbox).toHaveBeenCalledTimes(1);
    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
    expect(h.repository.startMessageProcessing).not.toHaveBeenCalled();
    expect(h.callbackService.notifyStarted).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "archived"] as const)(
    "does not dispatch queued work for a %s session",
    async (status) => {
      const h = buildQueue();
      h.repository.getSession.mockReturnValue(createSession({ status }));
      h.repository.getNextPendingMessage.mockReturnValue(createMessage());

      await h.queue.processMessageQueue();

      expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
      expect(h.sandboxLifecycle.spawnSandbox).not.toHaveBeenCalled();
      expect(h.wsManager.send).not.toHaveBeenCalled();
    }
  );

  it("does not block queue processing on the sandbox spawn", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());
    let resolveSpawn!: () => void;
    h.sandboxLifecycle.spawnSandbox.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSpawn = resolve;
      })
    );

    // Resolves immediately even though the spawn is still in flight; the
    // spawn is handed to backgroundTasks so the prompt response is not held open.
    await h.queue.processMessageQueue();

    expect(h.backgroundTasks.submissions).toHaveLength(1);
    resolveSpawn();
    await h.backgroundTasks.settle();
  });

  it("reports sandbox_error when the background spawn throws", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());
    h.sandboxLifecycle.spawnSandbox.mockRejectedValue(new Error("modal exploded"));

    await h.queue.processMessageQueue();
    await h.backgroundTasks.settle();

    // Routed through the lifecycle manager rather than broadcast directly, so
    // the reason is persisted too and survives the reload someone does to read it.
    expect(h.sandboxLifecycle.reportSandboxError).toHaveBeenCalledWith("modal exploded");
    expect(h.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox_error" })
    );
    // The spawn failure is absorbed by the boundary, not thrown at the caller.
    expect(h.backgroundTasks.failures).toEqual([expect.any(Error)]);
  });

  it("rejects a prompt whose session closed while its fingerprint was being hashed", async () => {
    const h = buildQueue();
    const session = createSession();
    h.repository.getSession.mockImplementation(() => session);
    const ws = {} as WebSocket;

    // The fingerprint hash is the first await; the cancel lands there.
    const handled = h.queue.handlePromptMessage(ws, createClientInfo(), {
      content: "hello",
      clientRequestId: "req-1",
    });
    session.status = "cancelled";
    await handled;

    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.sessionStatus.transition).not.toHaveBeenCalled();
    expect(h.wsManager.send).toHaveBeenCalledWith(
      ws,
      expect.objectContaining({ type: "error", code: "SESSION_NOT_PROMPTABLE" })
    );
  });

  it("marks session active when a prompt is enqueued", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), { content: "hello" });

    expect(h.sessionStatus.transition).toHaveBeenCalledWith("active");
  });

  it("deduplicates a correlated web prompt before attachment lookup or mutation", async () => {
    const h = buildQueue();
    h.repository.getMessageByClientRequestId.mockReturnValue(
      createMessage({
        id: "msg-existing",
        client_request_id: "request-1",
        request_fingerprint: await fingerprintWebPrompt("part-1", {
          content: "same",
          model: "anthropic/claude-haiku-4-5",
          reasoningEffort: "high",
          attachments: [{ name: "shot.png", attachmentId: "up-1" }],
        }),
      })
    );

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      clientRequestId: "request-1",
      content: "same",
      model: "anthropic/claude-haiku-4-5",
      reasoningEffort: "high",
      attachments: [{ name: "shot.png", attachmentId: "up-1" }],
    });

    expect(h.attachmentRepository.getUnreferenced).not.toHaveBeenCalled();
    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.log.info).toHaveBeenCalledWith(
      "prompt.enqueue",
      expect.objectContaining({
        outcome: "deduplicated",
        queue_depth_before: 1,
        queue_depth_after: 1,
      })
    );
    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "prompt_queued",
        clientRequestId: "request-1",
        messageId: "msg-existing",
      })
    );
  });

  it("returns a null position when retrying a completed correlated prompt", async () => {
    const h = buildQueue();
    h.repository.getMessageByClientRequestId.mockReturnValue(
      createMessage({
        id: "msg-complete",
        status: "completed",
        client_request_id: "request-complete",
        request_fingerprint: await fingerprintWebPrompt("part-1", { content: "same" }),
      })
    );
    h.repository.getUnfinishedMessagePosition.mockReturnValue(null);

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      clientRequestId: "request-complete",
      content: "same",
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prompt_queued", position: null })
    );
  });

  it("rejects reuse of a web request ID with a different participant or payload", async () => {
    const h = buildQueue();
    h.repository.getMessageByClientRequestId.mockReturnValue(
      createMessage({
        id: "msg-existing",
        author_id: "part-other",
        client_request_id: "request-1",
        request_fingerprint: "different",
      })
    );

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      clientRequestId: "request-1",
      content: "changed",
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "PROMPT_REQUEST_CONFLICT" })
    );
    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith(
      "prompt.enqueue",
      expect.objectContaining({ outcome: "conflict", queue_depth_before: 1, queue_depth_after: 1 })
    );
  });

  it("rejects the unfinished queue limit before attachments or message mutation", async () => {
    const h = buildQueue();
    h.repository.getPendingOrProcessingCount.mockReturnValue(MAX_UNFINISHED_PROMPTS);

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      clientRequestId: "request-full",
      content: "queued",
      attachments: [{ name: "shot.png", attachmentId: "up-1" }],
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        code: "PROMPT_QUEUE_FULL",
        clientRequestId: "request-full",
      })
    );
    expect(h.attachmentRepository.getUnreferenced).not.toHaveBeenCalled();
    expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
    expect(h.log.warn).toHaveBeenCalledWith(
      "prompt.enqueue",
      expect.objectContaining({
        outcome: "rejected",
        reason: "queue_full",
        queue_depth_before: MAX_UNFINISHED_PROMPTS,
        queue_depth_after: MAX_UNFINISHED_PROMPTS,
      })
    );
  });

  it("stores attachments on the pending message without creating a timeline event", async () => {
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

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
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
  });

  it("does not broadcast a queued follow-up before it starts processing", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessage.mockReturnValue({ id: "msg-running" });

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      content: "queued follow-up",
    });

    expect(
      h.broadcast.mock.calls.filter(
        ([message]) => message.type === "sandbox_event" && message.event.type === "user_message"
      )
    ).toHaveLength(0);
    expect(h.repository.startMessageProcessing).not.toHaveBeenCalled();
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

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
      content: "look",
      attachments: [{ name: "shot.png", attachmentId: "up-1" }],
    });

    expect(h.wsManager.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "INVALID_ATTACHMENTS" })
    );
    expect(h.repository.createEvent).not.toHaveBeenCalled();
    expect(h.sessionStatus.transition).not.toHaveBeenCalled();
  });

  it("rejects upload references that cannot be claimed", async () => {
    const h = buildQueue();

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
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
      h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
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

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
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

  it("materializes the user_message at processing start", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.repository.startMessageProcessing).toHaveBeenCalledWith(
      "msg-1",
      expect.any(Number),
      expect.objectContaining({
        type: "user_message",
        messageId: "msg-1",
        content: "hello",
      })
    );
    const event = h.repository.startMessageProcessing.mock.calls[0][2];
    expect(event).not.toHaveProperty("attachments");
    expect(event.timestamp * 1000).toBe(h.repository.startMessageProcessing.mock.calls[0][1]);
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("preserves Autofix origin on the canonical dispatch-time user event", async () => {
    const h = buildQueue();
    h.repository.getParticipantById.mockReturnValue(
      createParticipant({ scm_user_id: "255062780", scm_login: "open-inspect[bot]" })
    );
    const origin = {
      kind: "review",
      authorType: "human",
      feedbackUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1234",
    } as const;
    h.repository.getNextPendingMessage.mockReturnValue(
      createMessage({ source: "github", origin_context: JSON.stringify(origin) })
    );
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);

    await h.queue.processMessageQueue();

    const event = h.repository.startMessageProcessing.mock.calls[0][2];
    expect(event).toEqual(
      expect.objectContaining({
        origin,
        author: expect.objectContaining({
          avatar: "https://avatars.githubusercontent.com/u/255062780?v=4",
        }),
      })
    );
    expect(serverMessageSchema.parse({ type: "sandbox_event", event })).toEqual({
      type: "sandbox_event",
      event: expect.objectContaining({ origin }),
    });
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event });
  });

  it("fails an unavailable prompt model before spawning or dispatching", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValueOnce(
      createMessage({ model: "xai/grok-4.5" })
    );
    h.getProviderAuthenticationError.mockResolvedValue(
      "No xAI authentication is configured for this session"
    );

    await h.queue.processMessageQueue();

    expect(h.getProviderAuthenticationError).toHaveBeenCalledWith("xai/grok-4.5");
    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-1",
        success: false,
        error: "No xAI authentication is configured for this session",
      }),
      expect.any(Number),
      "pending"
    );
    expect(h.sandboxLifecycle.spawnSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("continues with the next prompt after rejecting unavailable authentication", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage
      .mockReturnValueOnce(createMessage({ id: "blocked", model: "xai/grok-4.5" }))
      .mockReturnValueOnce(createMessage({ id: "eligible", model: "anthropic/claude-haiku-4-5" }));
    h.getProviderAuthenticationError.mockImplementation(async (model) =>
      model === "xai/grok-4.5" ? "No xAI authentication is configured" : null
    );
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "blocked", success: false }),
      expect.any(Number),
      "pending"
    );
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "prompt", messageId: "eligible" })
    );
  });

  it("uses the canonical profile userId instead of a bot transport identity", async () => {
    const h = buildQueue();
    const participant = createParticipant({
      scm_name: null,
      scm_login: null,
      user_id: "slack:U123",
      canonical_user_id: "user-pat",
    });

    h.repository.getParticipantById.mockReturnValue(participant);
    h.repository.getNextPendingMessage.mockReturnValue(
      createMessage({ author_id: participant.id, source: "slack" })
    );
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);

    await h.queue.processMessageQueue();

    expect(h.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sandbox_event",
        event: expect.objectContaining({
          author: expect.objectContaining({ userId: "user-pat", name: "slack:U123" }),
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

    expect(h.repository.startMessageProcessing).toHaveBeenCalledWith(
      "msg-42",
      expect.any(Number),
      expect.objectContaining({ type: "user_message", messageId: "msg-42" })
    );
    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({ type: "prompt", messageId: "msg-42" })
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: true });
    expect(h.broadcast).toHaveBeenCalledWith({
      type: "prompt_queue_updated",
      promptQueue: expect.any(Array),
    });
  });

  it("leaves the prompt pending and timeline untouched when sandbox send fails", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValueOnce(createMessage({ id: "msg-unsent" }));
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);
    h.wsManager.send.mockReturnValue(false);

    await h.queue.processMessageQueue();

    expect(h.repository.startMessageProcessing).toHaveBeenCalledWith(
      "msg-unsent",
      expect.any(Number),
      expect.objectContaining({ type: "user_message", messageId: "msg-unsent" })
    );
    expect(h.repository.updateMessageToPending).toHaveBeenCalledWith("msg-unsent");
    expect(
      h.broadcast.mock.calls.filter(
        ([message]) => message.type === "sandbox_event" && message.event.type === "user_message"
      )
    ).toHaveLength(0);
    expect(h.callbackService.notifyStarted).not.toHaveBeenCalled();
    expect(h.sandboxLifecycle.terminateUnresponsiveSandbox).toHaveBeenCalledWith(
      "prompt_dispatch_send_failed"
    );
    expect(h.repository.getNextPendingMessage).toHaveBeenCalledTimes(2);
  });

  it("does not dispatch when another worker wins the processing claim", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-lost" }));
    h.repository.startMessageProcessing.mockReturnValue(false);
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);

    await h.queue.processMessageQueue();

    expect(h.wsManager.send).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "processing_status" })
    );
  });

  it("records enqueue depth before and after without prompt content", async () => {
    const h = buildQueue();
    h.repository.getPendingOrProcessingCount.mockReturnValueOnce(2).mockReturnValueOnce(3);

    await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), { content: "secret" });

    const enqueueLog = h.log.info.mock.calls.find(([event]) => event === "prompt.enqueue")?.[1];
    expect(enqueueLog).toEqual(
      expect.objectContaining({ outcome: "enqueued", queue_depth_before: 2, queue_depth_after: 3 })
    );
    expect(enqueueLog).not.toHaveProperty("content");
  });

  it("drops a persisted reasoning effort that the session model does not support", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());
    h.repository.getSession.mockReturnValue(
      createSession({ model: "xai/grok-build-0.1", reasoning_effort: "high" })
    );
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);

    await h.queue.processMessageQueue();

    expect(h.wsManager.send).toHaveBeenCalledWith(
      sandboxWs,
      expect.objectContaining({
        model: "xai/grok-build-0.1",
        reasoningEffort: undefined,
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

  it("resolves each dispatched prompt's Git author from its current participant", async () => {
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
    expect(h.backgroundTasks.submissions).toHaveLength(1);
  });

  it("does not notify the integration when sandbox dispatch fails", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValueOnce(createMessage({ id: "msg-failed" }));
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);
    h.wsManager.send.mockReturnValue(false);

    await h.queue.processMessageQueue();

    expect(h.callbackService.notifyStarted).not.toHaveBeenCalled();
    expect(h.backgroundTasks.submissions).toHaveLength(0);
  });

  describe("execution timeout scheduling", () => {
    function dispatchPrompt(h: ReturnType<typeof buildQueue>) {
      h.repository.getNextPendingMessage.mockReturnValue(createMessage());
      h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);
      return h.queue.processMessageQueue();
    }

    it("schedules the execution deadline when no alarm is set", async () => {
      const h = buildQueue();
      const before = Date.now();

      await dispatchPrompt(h);

      expect(h.setAlarm).toHaveBeenCalledTimes(1);
      const deadline = h.setAlarm.mock.calls[0][0];
      expect(deadline).toBeGreaterThanOrEqual(before + EXECUTION_TIMEOUT_MS);
      expect(deadline).toBeLessThanOrEqual(Date.now() + EXECUTION_TIMEOUT_MS);
    });

    it("arms each deadline with the timeout current at that dispatch", async () => {
      const h = buildQueue();
      // Model /internal/init persisting a sandbox_settings override after the
      // graph (and this queue) was already built eagerly.
      h.setExecutionTimeoutMs(EXECUTION_TIMEOUT_MS * 3);
      const before = Date.now();

      await dispatchPrompt(h);

      expect(h.setAlarm).toHaveBeenCalledTimes(1);
      const first = h.setAlarm.mock.calls[0][0];
      expect(first).toBeGreaterThanOrEqual(before + EXECUTION_TIMEOUT_MS * 3);
      expect(first).toBeLessThanOrEqual(Date.now() + EXECUTION_TIMEOUT_MS * 3);

      // A later dispatch must re-resolve — the value is never captured, not
      // even at first use.
      h.setExecutionTimeoutMs(EXECUTION_TIMEOUT_MS * 5);
      const beforeSecond = Date.now();
      await dispatchPrompt(h);

      expect(h.setAlarm).toHaveBeenCalledTimes(2);
      const second = h.setAlarm.mock.calls[1][0];
      expect(second).toBeGreaterThanOrEqual(beforeSecond + EXECUTION_TIMEOUT_MS * 5);
      expect(second).toBeLessThanOrEqual(Date.now() + EXECUTION_TIMEOUT_MS * 5);
    });

    it("keeps an earlier existing alarm", async () => {
      const h = buildQueue();
      h.getAlarm.mockResolvedValue(Date.now() + 1000);

      await dispatchPrompt(h);

      expect(h.setAlarm).not.toHaveBeenCalled();
    });

    it("replaces a later existing alarm with the execution deadline", async () => {
      const h = buildQueue();
      h.getAlarm.mockResolvedValue(Date.now() + EXECUTION_TIMEOUT_MS * 10);
      const before = Date.now();

      await dispatchPrompt(h);

      expect(h.setAlarm).toHaveBeenCalledTimes(1);
      const deadline = h.setAlarm.mock.calls[0][0];
      expect(deadline).toBeGreaterThanOrEqual(before + EXECUTION_TIMEOUT_MS);
      expect(deadline).toBeLessThanOrEqual(Date.now() + EXECUTION_TIMEOUT_MS);
    });

    it("does not schedule when the prompt is deferred for sandbox spawn", async () => {
      const h = buildQueue();
      h.repository.getNextPendingMessage.mockReturnValue(createMessage());

      await h.queue.processMessageQueue();

      expect(h.getAlarm).not.toHaveBeenCalled();
      expect(h.setAlarm).not.toHaveBeenCalled();
    });
  });

  it("delegates stop finalization before broadcasting idle and stopping the sandbox", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: 1 } as WebSocket;
    h.wsManager.getSandboxSocket.mockReturnValue(sandboxWs);
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-9",
      created_at: 900,
    });

    await h.queue.stopExecution();

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "execution_complete",
        messageId: "msg-9",
        success: false,
        error: "Execution was stopped",
      }),
      expect.any(Number),
      "processing"
    );
    expect(h.repository.markMessageAwaitingStopConfirmation).toHaveBeenCalledWith(
      "msg-9",
      expect.any(Number)
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "processing_status", isProcessing: false });
    expect(h.wsManager.send).toHaveBeenCalledWith(sandboxWs, { type: "stop" });
    expect(h.repository.recordMessageCompletion.mock.invocationCallOrder[0]).toBeLessThan(
      h.repository.markMessageAwaitingStopConfirmation.mock.invocationCallOrder[0]
    );
    expect(h.projectTerminalMessage).toHaveBeenCalledWith("msg-9", 1000, expect.any(Number));
    expect(
      h.repository.markMessageAwaitingStopConfirmation.mock.invocationCallOrder[0]
    ).toBeLessThan(h.wsManager.send.mock.invocationCallOrder[0]);
  });

  it("projects terminal unread state before broadcasting synthetic completion", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue(
      createMessage({ id: "msg-ordered", status: "processing", created_at: 900 })
    );
    let resolveProjection!: () => void;
    h.projectTerminalMessage.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveProjection = resolve;
      })
    );

    await h.queue.stopExecution();
    expect(h.broadcast).not.toHaveBeenCalledWith({
      type: "sandbox_event",
      event: expect.objectContaining({ type: "execution_complete" }),
    });

    resolveProjection();
    await h.backgroundTasks.settle();
    expect(h.broadcast).toHaveBeenCalledWith({
      type: "sandbox_event",
      event: expect.objectContaining({ type: "execution_complete" }),
    });
  });

  it("waits for sandbox stop confirmation before dispatching the next prompt", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-running",
      created_at: 900,
    });
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-next" }));
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);

    await h.queue.stopExecution();

    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalledWith(
      "msg-next",
      expect.any(Number)
    );
    expect(h.wsManager.send).toHaveBeenCalledWith(expect.anything(), { type: "stop" });
    expect(h.wsManager.send).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prompt", messageId: "msg-next" })
    );
    expect(h.setAlarm).toHaveBeenCalledOnce();
  });

  it("terminates the sandbox and resumes safely when stop cannot be sent", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-running",
      created_at: 900,
    });
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-next" }));
    h.wsManager.getSandboxSocket.mockReturnValue(null);

    await h.queue.stopExecution();

    expect(h.sandboxLifecycle.terminateUnresponsiveSandbox).toHaveBeenCalledWith(
      "stop_send_failed"
    );
    expect(h.repository.getNextPendingMessage).toHaveBeenCalled();
    expect(h.repository.clearMessageAwaitingStopConfirmation).not.toHaveBeenCalled();
  });

  it("terminates the sandbox when the connected socket rejects the stop send", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-running",
      created_at: 900,
    });
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);
    h.wsManager.send.mockReturnValue(false);

    await h.queue.stopExecution();

    expect(h.sandboxLifecycle.terminateUnresponsiveSandbox).toHaveBeenCalledWith(
      "stop_send_failed"
    );
    expect(h.repository.getNextPendingMessage).toHaveBeenCalled();
  });

  it("terminates the sandbox after the bounded stop confirmation deadline", async () => {
    const h = buildQueue();
    h.repository.getMessageAwaitingStopConfirmation
      .mockReturnValueOnce({
        id: "msg-stopped",
        deadline: Date.now() - 1,
      })
      .mockReturnValue(null);

    await h.queue.recoverStopConfirmationTimeout();

    expect(h.sandboxLifecycle.terminateUnresponsiveSandbox).toHaveBeenCalledWith(
      "stop_confirmation_timeout"
    );
    expect(h.repository.clearMessageAwaitingStopConfirmation).not.toHaveBeenCalled();
    expect(h.repository.getNextPendingMessage).toHaveBeenCalled();
  });

  it("re-arms a future stop confirmation deadline when an earlier alarm fired", async () => {
    const h = buildQueue();
    const deadline = Date.now() + 10_000;
    h.repository.getMessageAwaitingStopConfirmation.mockReturnValue({
      id: "msg-stopped",
      deadline,
    });

    await h.queue.recoverStopConfirmationTimeout();

    expect(h.sandboxLifecycle.terminateUnresponsiveSandbox).not.toHaveBeenCalled();
    expect(h.setAlarm).toHaveBeenCalledExactlyOnceWith(deadline);
  });

  it("clears the marker and resumes only after definitive sandbox termination", async () => {
    const h = buildQueue();
    h.repository.getMessageAwaitingStopConfirmation
      .mockReturnValueOnce({ id: "msg-stopped", deadline: Date.now() - 1 })
      .mockReturnValue(null);

    await h.queue.resumeAfterSandboxTermination();

    expect(h.repository.clearMessageAwaitingStopConfirmation).toHaveBeenCalledWith("msg-stopped");
  });

  it("keeps queue dispatch blocked while a stopped prompt awaits confirmation", async () => {
    const h = buildQueue();
    h.repository.getMessageAwaitingStopConfirmation.mockReturnValue({
      id: "msg-stopped",
      deadline: Date.now() + 10_000,
    });
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-next" }));
    h.wsManager.getSandboxSocket.mockReturnValue({ readyState: 1 } as WebSocket);

    await h.queue.processMessageQueue();

    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalled();
  });

  it("suppresses session status reconcile when stopExecution is called with suppress flag", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-10",
      created_at: 900,
    });
    await h.queue.stopExecution({ suppressStatusReconcile: true });

    expect(h.sessionStatus.reconcileAfterExecution).not.toHaveBeenCalled();
  });

  it("does not finalize or stop when no message is processing", async () => {
    const h = buildQueue();

    await h.queue.stopExecution();
    await h.queue.failStuckProcessingMessage();

    expect(h.repository.recordMessageCompletion).not.toHaveBeenCalled();
    expect(h.wsManager.send).not.toHaveBeenCalledWith(expect.anything(), { type: "stop" });
    expect(h.sessionStatus.reconcileAfterExecution).not.toHaveBeenCalled();
  });

  it("emits completion events and callbacks for prompts cancelled before dispatch", async () => {
    const h = buildQueue();
    h.repository.listPendingMessagesWithCreatedAt.mockReturnValue([
      { id: "msg-pending", created_at: 700 },
    ]);
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-processing",
      created_at: 800,
    });

    h.queue.cancelExecution();

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-pending",
        error: "Execution was cancelled before it started",
      }),
      expect.any(Number),
      "pending"
    );
    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-processing",
        error: "Execution was cancelled",
      }),
      expect.any(Number),
      "processing"
    );
  });

  it("reconciles session status when failing a stuck processing message", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-timeout",
      created_at: 800,
    });
    await h.queue.failStuckProcessingMessage();

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-timeout",
        error: "Execution timed out (stuck processing)",
      }),
      expect.any(Number),
      "processing"
    );
    expect(h.sessionStatus.reconcileAfterExecution).toHaveBeenCalledWith(false);
  });

  it("uses a fatal sandbox reason for completion and callback notification", async () => {
    const h = buildQueue();
    h.repository.getProcessingMessageWithCreatedAt.mockReturnValue({
      id: "msg-crashed",
      created_at: 800,
    });

    await h.queue.failStuckProcessingMessage("OpenCode repeatedly crashed");
    await h.backgroundTasks.settle();

    expect(h.repository.recordMessageCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg-crashed",
        error: "OpenCode repeatedly crashed",
      }),
      expect.any(Number),
      "processing"
    );
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith(
      "msg-crashed",
      false,
      "OpenCode repeatedly crashed"
    );
    expect(h.sessionStatus.reconcileAfterExecution).toHaveBeenCalledWith(false);
  });

  it("redrives a pending prompt after fatal sandbox termination completes", async () => {
    const h = buildQueue();
    let resolveTermination!: (terminated: boolean) => void;
    h.sandboxLifecycle.terminateFailedSandbox.mockReturnValue(
      new Promise((resolve) => {
        resolveTermination = resolve;
      })
    );
    h.repository.getNextPendingMessage.mockReturnValue(createMessage({ id: "msg-pending" }));

    const handling = h.queue.handleFatalSandboxFailure("Sandbox crashed");
    await Promise.resolve();
    expect(h.sandboxLifecycle.spawnSandbox).not.toHaveBeenCalled();

    resolveTermination(true);
    await handling;
    await h.backgroundTasks.settle();

    expect(h.sandboxLifecycle.terminateFailedSandbox).toHaveBeenCalledWith("Sandbox crashed");
    expect(h.sandboxLifecycle.spawnSandbox).toHaveBeenCalledOnce();
  });

  describe("enqueuePromptFromApi", () => {
    it.each(["cancelled", "archived"] as const)(
      "rejects prompts for a %s session before inserting a message",
      async (status) => {
        const h = buildQueue();
        h.repository.getSession.mockReturnValue(createSession({ status }));
        h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

        await expect(
          h.queue.enqueuePromptFromApi({
            content: "Continue",
            authorId: "user-1",
            source: "agent",
          })
        ).rejects.toMatchObject({ sessionStatus: status });

        expect(h.repository.createMessageWithAttachments).not.toHaveBeenCalled();
        expect(h.participantService.create).not.toHaveBeenCalled();
        expect(h.repository.updateParticipantCoalesce).not.toHaveBeenCalled();
      }
    );

    it("rejects a websocket prompt before creating a participant", async () => {
      const h = buildQueue();
      h.repository.getSession.mockReturnValue(createSession({ status: "cancelled" }));
      h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

      await h.queue.handlePromptMessage({} as WebSocket, createClientInfo(), {
        content: "Continue",
      });

      expect(h.participantService.create).not.toHaveBeenCalled();
      expect(h.wsManager.send).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ code: "SESSION_NOT_PROMPTABLE" })
      );
    });

    it("creates participant with the enriched identity name when new", async () => {
      const h = buildQueue();
      h.participantService.getByUserId.mockReturnValue(null as unknown as ParticipantRow);

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github",
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
        source: "github",
      });

      expect(h.participantService.create).toHaveBeenCalledWith("github:1001", "github:1001");
    });

    it("updates stored SCM identity and tokens after successful enrichment", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github",
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

      expect(h.repository.updateParticipantCoalesce).toHaveBeenCalledWith("part-1", {
        scmName: "Trusted Octo Cat",
        scmEmail: "1001+octocat@users.noreply.github.com",
        scmLogin: "octocat",
        scmUserId: "1001",
        scmAccessTokenEncrypted: "enc-access",
        scmRefreshTokenEncrypted: "enc-refresh",
        scmTokenExpiresAt: 9999999,
      });
    });

    it("leaves stored enrichment unchanged when no snapshot is provided", async () => {
      const h = buildQueue();

      await h.queue.enqueuePromptFromApi({
        content: "Fix bug",
        authorId: "github:1001",
        source: "github",
      });

      expect(h.repository.updateParticipantCoalesce).not.toHaveBeenCalled();
    });
  });
});
