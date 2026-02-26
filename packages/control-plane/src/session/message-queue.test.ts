import { describe, expect, it, vi } from "vitest";
import { SessionMessageQueue } from "./message-queue";
import type { ClientInfo, Env, ServerMessage } from "../types";
import type { MessageRow, ParticipantRow, SessionRow } from "./types";

function createParticipant(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: "part-1",
    user_id: "user-1",
    scm_user_id: null,
    scm_login: "octocat",
    scm_email: null,
    scm_name: "Octo Cat",
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
    createMessage: vi.fn(),
    createEvent: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 1),
    getProcessingMessage: vi.fn(() => null as { id: string } | null),
    getNextPendingMessage: vi.fn(() => null as MessageRow | null),
    updateMessageToProcessing: vi.fn(),
    getParticipantById: vi.fn(() => createParticipant()),
    updateMessageCompletion: vi.fn(),
    upsertExecutionCompleteEvent: vi.fn(),
  };

  const wsManager = {
    getSandboxSocket: vi.fn(() => null as WebSocket | null),
    send: vi.fn(() => true),
  };

  const participantService = {
    getByUserId: vi.fn(() => createParticipant()),
    create: vi.fn((userId: string, _name: string) => createParticipant({ user_id: userId })),
  };

  const callbackService = {
    notifyComplete: vi.fn(async () => {}),
  };

  const broadcast = vi.fn((_message: ServerMessage) => {});
  const spawnSandbox = vi.fn(async () => {});
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
  });

  return {
    queue,
    repository,
    wsManager,
    broadcast,
    spawnSandbox,
    waitUntil,
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
    expect(h.repository.createMessage).not.toHaveBeenCalled();
  });

  it("spawns sandbox when queue has work but no sandbox socket", async () => {
    const h = buildQueue();
    h.repository.getNextPendingMessage.mockReturnValue(createMessage());

    await h.queue.processMessageQueue();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_spawning" });
    expect(h.spawnSandbox).toHaveBeenCalledTimes(1);
    expect(h.repository.updateMessageToProcessing).not.toHaveBeenCalled();
  });

  it("dispatches prompt command when sandbox socket exists", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
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

  it("marks processing message failed and broadcasts synthetic completion on stop", async () => {
    const h = buildQueue();
    const sandboxWs = { readyState: WebSocket.OPEN } as WebSocket;
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
  });
});
