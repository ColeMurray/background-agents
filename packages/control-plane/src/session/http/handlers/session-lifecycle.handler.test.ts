import { describe, expect, it, vi } from "vitest";
import type { SandboxRow, SessionRow } from "../../types";
import { SessionLifecycleHandler } from "./session-lifecycle.handler";
import type { SessionTitleService } from "../../title-service";
import type { WebSocketManager } from "../../../sandbox/lifecycle/manager";
import type { SessionStatusService } from "../../session-status-service";
import type { MessageRepository } from "../../message-repository";
import type { SandboxRepository } from "../../sandbox-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

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
    snapshot_runtime_version: null,
    runtime_version: null,
    auth_token: null,
    auth_token_hash: null,
    status: "ready",
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
    active_socket_id: null,
    created_at: 1,
    ...overrides,
  };
}

function createHandler() {
  const getSession = vi.fn<() => SessionRow | null>();
  const repository = {
    getPendingOrProcessingCount: vi.fn(() => 0),
    getMessageCount: vi.fn(() => 0),
    getSession,
  };
  const getSandbox = vi.fn<() => SandboxRow | null>();
  const updateSandboxStatus = vi.fn();
  const sandboxRepository = {
    getSandbox,
    updateSandboxStatus,
  } as unknown as SandboxRepository;
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

  const lifecycleHandler = new SessionLifecycleHandler(
    repository as unknown as SessionCoreRepository,
    sandboxRepository,
    repository as unknown as MessageRepository,
    statusService,
    { applySessionTitleUpdate } as unknown as SessionTitleService,
    {
      getSandboxWebSocket: getSandboxSocket,
      detachSandboxWebSocket: vi.fn(),
      sendToSandbox,
      getConnectedClientCount: vi.fn(() => 0),
    } as unknown as WebSocketManager,
    "session-do-id",
    cancelSession
  );

  const handler = {
    getState: () => lifecycleHandler.getState(),
    updateTitle: (request: Request) => lifecycleHandler.updateTitle(request),
    archive: (_request?: Request) => lifecycleHandler.archive(),
    unarchive: (_request?: Request) => lifecycleHandler.unarchive(),
    expireDraft: () => lifecycleHandler.expireDraft(),
    cancel: () => lifecycleHandler.cancel(),
  };

  return {
    handler,
    repository,
    sandboxRepository,
    getSession,
    getSandbox,
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

describe("SessionLifecycleHandler", () => {
  it("returns 404 state response when session is missing", async () => {
    const { handler, getSession } = createHandler();
    getSession.mockReturnValue(null);

    const response = handler.getState();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Session not found");
  });

  it("maps state response with sandbox details", async () => {
    const { handler, getSession, getSandbox } = createHandler();
    getSession.mockReturnValue(createSession());
    getSandbox.mockReturnValue(createSandbox());

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
        status: "ready",
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

  it("applies a manual title update and returns the normalized title", async () => {
    const { handler, getSession, applySessionTitleUpdate } = createHandler();
    getSession.mockReturnValue(createSession());

    const response = await handler.updateTitle(
      new Request("http://internal/internal/update-title", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: " New Title " }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: "New Title" });
    expect(applySessionTitleUpdate).toHaveBeenCalledWith("New Title", { onlyIfUnset: false });
  });

  it("archives successfully without participant authorization", async () => {
    const { handler, getSession, transition } = createHandler();
    getSession.mockReturnValue(createSession());
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
    const { handler, getSession, repository, transition } = createHandler();
    getSession.mockReturnValue(createSession());
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
    const { handler, getSession, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "cancelled" }));

    const response = await handler.archive(
      new Request("http://internal/internal/archive", {
        method: "POST",
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(409);
    expect(transition).not.toHaveBeenCalled();
  });

  // Unarchive must not assert a status of its own. Forcing "active" left a
  // session with no queued work claiming to be working: nothing settles an idle
  // `active` session, because every settle path is driven by execution events,
  // so it stayed in the sidebar's in-progress group until the next prompt.
  // Deriving the status from message state is what makes the restore honest.
  //
  // The settle service is mocked here, so this asserts delegation and
  // pass-through only -- one behaviour, not four. Which status each message
  // state actually produces is covered against real DO storage in
  // test/integration/session-lifecycle.test.ts.
  it("delegates to the settle service and returns whatever it decides", async () => {
    const { handler, getSession, transition, settleFromMessageState } = createHandler();
    getSession.mockReturnValue(createSession({ status: "archived" }));
    settleFromMessageState.mockResolvedValue("completed");

    const response = await handler.unarchive(
      new Request("http://internal/internal/unarchive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "user-1" }),
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "completed" });
    expect(settleFromMessageState).toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("returns 409 when unarchiving a session that is not archived", async () => {
    const { handler, getSession, transition } = createHandler();
    getSession.mockReturnValue(createSession({ status: "cancelled" }));

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
    getSandbox.mockReturnValue(createSandbox({ status: "ready" }));
    cancelSession.mockResolvedValue(undefined);
    getSandboxSocket.mockReturnValue(ws);

    const response = await handler.cancel();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelled" });
    expect(cancelSession).toHaveBeenCalledOnce();
    expect(sendToSandbox).toHaveBeenCalledWith({ type: "shutdown" });
    expect(updateSandboxStatus).toHaveBeenCalledWith("stopped");
  });
});
