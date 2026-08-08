import { describe, expect, it, vi } from "vitest";
import { SessionStatusService } from "./session-status-service";
import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionRow, ArtifactRow } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionMessenger } from "./messenger";

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
    total_cost: 2.5,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  } as SessionRow;
}

function harness(options: { session?: SessionRow | null; sessionIndex?: null } = {}) {
  const session = options.session === undefined ? createSession() : options.session;

  const repository = {
    getSession: vi.fn(() => session),
    updateSessionStatus: vi.fn(),
    getPendingOrProcessingCount: vi.fn(() => 0),
    getMessageCount: vi.fn(() => 3),
    getActiveDurationMs: vi.fn(() => 4500),
    listArtifacts: vi.fn(
      () => [{ type: "pr" }, { type: "screenshot" }, { type: "pr" }] as ArtifactRow[]
    ),
  };

  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(() => true) } as SessionMessenger;

  const sessionIndex =
    options.sessionIndex === null
      ? null
      : {
          updateStatus: vi.fn(async () => true),
          updateMetrics: vi.fn(async () => true),
        };

  const waitUntil = vi.fn();
  const ctx = { waitUntil, id: { toString: () => "do-id" } } as unknown as DurableObjectState;

  const parentFetch = vi.fn(async (_request: Request) => new Response(null, { status: 200 }));
  const parentStub = { fetch: parentFetch };
  const parentSessions = {
    idFromName: vi.fn(() => "parent-do-id"),
    get: vi.fn(() => parentStub),
  };

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  const service = new SessionStatusService(
    ctx,
    log as unknown as Logger,
    repository as unknown as SessionRepository,
    messenger,
    sessionIndex as unknown as SessionIndexStore | null,
    parentSessions as unknown as DurableObjectNamespace
  );

  return {
    service,
    repository,
    broadcast,
    sessionIndex,
    waitUntil,
    parentSessions,
    parentFetch,
    log,
  };
}

describe("SessionStatusService.transition", () => {
  it("returns false without side effects when there is no session", async () => {
    const h = harness({ session: null });

    expect(await h.service.transition("active")).toBe(false);

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.sessionIndex!.updateStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("persists, mirrors to the index, and broadcasts on a real transition", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    expect(await h.service.transition("active")).toBe(true);

    expect(h.repository.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "active",
      expect.any(Number)
    );
    const updatedAt = h.repository.updateSessionStatus.mock.calls[0][2] as number;
    expect(updatedAt).toBeGreaterThan(2000);
    expect(h.sessionIndex!.updateStatus).toHaveBeenCalledWith(
      "public-session-1",
      "active",
      updatedAt
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("short-circuits on same status: refreshes the index but neither persists nor broadcasts", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    expect(await h.service.transition("active")).toBe(false);

    expect(h.sessionIndex!.updateStatus).toHaveBeenCalledWith("public-session-1", "active", 2000);
    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.parentFetch).not.toHaveBeenCalled();
  });

  it("syncs metrics on a terminal transition", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.transition("completed");

    expect(h.sessionIndex!.updateMetrics).toHaveBeenCalledWith("public-session-1", {
      totalCost: 2.5,
      activeDurationMs: 4500,
      messageCount: 3,
      prCount: 2,
    });
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it("syncs metrics even when already in the terminal status", async () => {
    const h = harness({ session: createSession({ status: "failed" }) });

    expect(await h.service.transition("failed")).toBe(false);

    expect(h.sessionIndex!.updateMetrics).toHaveBeenCalledWith(
      "public-session-1",
      expect.any(Object)
    );
  });

  it("does not sync metrics on a non-terminal transition", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    await h.service.transition("active");

    expect(h.sessionIndex!.updateMetrics).not.toHaveBeenCalled();
  });

  it("logs index sync failures without throwing", async () => {
    const h = harness({ session: createSession({ status: "created" }) });
    h.sessionIndex!.updateStatus.mockRejectedValue(new Error("d1 down"));

    expect(await h.service.transition("active")).toBe(true);

    expect(h.log.error).toHaveBeenCalledWith(
      "session_index.update_status.background_error",
      expect.objectContaining({
        session_id: "public-session-1",
        status: "active",
        error: expect.any(Error),
      })
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("skips index and metrics writes when no session index is bound", async () => {
    const h = harness({ session: createSession({ status: "active" }), sessionIndex: null });

    expect(await h.service.transition("completed")).toBe(true);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "completed" });
    expect(h.waitUntil).not.toHaveBeenCalled();
  });

  it("notifies the parent session fire-and-forget via ctx.waitUntil", async () => {
    const h = harness({
      session: createSession({ status: "active", parent_session_id: "parent-1" }),
    });

    await h.service.transition("completed");

    expect(h.parentSessions.idFromName).toHaveBeenCalledWith("parent-1");
    expect(h.parentFetch).toHaveBeenCalledTimes(1);
    const request = h.parentFetch.mock.calls[0][0];
    expect(request.url).toBe(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate));
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({
      childSessionId: "public-session-1",
      status: "completed",
      title: "Session title",
    });
    expect(h.waitUntil).toHaveBeenCalled();
  });

  it("does not notify a parent when the session has none", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    await h.service.transition("active");

    expect(h.parentFetch).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.reconcileAfterExecution", () => {
  it("returns to active when more prompts are pending", async () => {
    const h = harness({ session: createSession({ status: "created" }) });
    h.repository.getPendingOrProcessingCount.mockReturnValue(2);

    await h.service.reconcileAfterExecution(true);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "active" });
  });

  it("completes when idle and the execution succeeded", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.reconcileAfterExecution(true);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "completed" });
  });

  it("fails when idle and the execution failed", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.reconcileAfterExecution(false);

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "failed" });
  });
});

describe("SessionStatusService.notifyParentOfChildUpdate", () => {
  it("posts the child update to the parent Durable Object", async () => {
    const h = harness();

    h.service.notifyParentOfChildUpdate(
      { parent_session_id: "parent-1", title: "Old title" },
      "public-session-1",
      { status: "active", title: "New title" }
    );

    expect(h.parentSessions.idFromName).toHaveBeenCalledWith("parent-1");
    const request = h.parentFetch.mock.calls[0][0];
    expect(await request.json()).toEqual({
      childSessionId: "public-session-1",
      status: "active",
      title: "New title",
    });
    expect(h.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("logs (and does not throw) when the parent notification fails", async () => {
    const h = harness();
    h.parentFetch.mockRejectedValue(new Error("parent unreachable"));

    h.service.notifyParentOfChildUpdate(
      { parent_session_id: "parent-1", title: null },
      "public-session-1",
      { status: "failed", title: null }
    );

    // Drain the fire-and-forget promise handed to waitUntil.
    await h.waitUntil.mock.calls[0][0];

    expect(h.log.error).toHaveBeenCalledWith(
      "notify_parent.failed",
      expect.objectContaining({
        parent_id: "parent-1",
        child_id: "public-session-1",
        status: "failed",
        error: expect.any(Error),
      })
    );
  });

  it("is a no-op without a parent session id", () => {
    const h = harness();

    h.service.notifyParentOfChildUpdate({ parent_session_id: null, title: null }, "child-1", {
      status: "active",
      title: null,
    });

    expect(h.parentSessions.idFromName).not.toHaveBeenCalled();
    expect(h.waitUntil).not.toHaveBeenCalled();
  });
});
