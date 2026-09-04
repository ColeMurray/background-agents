import { describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { SessionStatusService } from "./session-status-service";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionRow, ArtifactRow, MessageRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { ArtifactRepository } from "./artifact-repository";
import type { MessageRepository } from "./message-repository";
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
    vnc_enabled: 0,
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
    getLatestTerminalMessage: vi.fn(() => null as MessageRow | null),
    getMessageCount: vi.fn(() => 3),
    getActiveDurationMs: vi.fn(() => 4500),
  };
  const artifactRepository = {
    listArtifacts: vi.fn(
      () => [{ type: "pr" }, { type: "screenshot" }, { type: "pr" }] as ArtifactRow[]
    ),
  } as unknown as ArtifactRepository;

  const broadcast = vi.fn();
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) } as SessionMessenger;

  const sessionIndex =
    options.sessionIndex === null
      ? null
      : {
          updateStatus: vi.fn(async () => true),
          repairStatus: vi.fn(async () => true),
          finalizeChildAdmission: vi.fn(async () => {}),
          updateMetrics: vi.fn(async () => true),
        };

  const parentFetch = vi.fn(
    async (_sessionId: string, _path: string, _init?: RequestInit) =>
      new Response(null, { status: 200 })
  );
  const parentSessions: SessionRuntimeClient = { fetch: parentFetch };

  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  const backgroundTasks = createTestBackgroundTasks();

  const service = new SessionStatusService(
    backgroundTasks,
    log as unknown as Logger,
    repository as unknown as SessionCoreRepository,
    repository as unknown as MessageRepository,
    artifactRepository,
    messenger,
    sessionIndex as unknown as SessionIndexStore | null,
    parentSessions
  );

  return {
    service,
    repository,
    artifactRepository,
    broadcast,
    sessionIndex,
    backgroundTasks,
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
    expect(h.sessionIndex!.finalizeChildAdmission).toHaveBeenCalledWith("public-session-1");
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
    expect(h.backgroundTasks.submissions).not.toHaveLength(0);
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
    expect(h.backgroundTasks.submissions).toHaveLength(0);
  });

  it("submits the parent notification as a background job", async () => {
    const h = harness({
      session: createSession({ status: "active", parent_session_id: "parent-1" }),
    });

    await h.service.transition("completed");

    expect(h.parentFetch).toHaveBeenCalledTimes(1);
    const [parentId, path, init] = h.parentFetch.mock.calls[0];
    expect(parentId).toBe("parent-1");
    expect(path).toBe(SessionInternalPaths.childSessionUpdate);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      childSessionId: "public-session-1",
      status: "completed",
      title: "Session title",
    });
    expect(h.backgroundTasks.submissions).not.toHaveLength(0);
  });

  it("does not notify a parent when the session has none", async () => {
    const h = harness({ session: createSession({ status: "created" }) });

    await h.service.transition("active");

    expect(h.parentFetch).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.cancel", () => {
  it("closes local status and unfinished messages before publishing projections", async () => {
    const h = harness({ session: createSession({ status: "active" }) });
    let releaseIndex!: () => void;
    h.sessionIndex!.updateStatus.mockImplementation(
      () => new Promise<boolean>((resolve) => (releaseIndex = () => resolve(true)))
    );
    const terminalize = vi.fn();

    const cancellation = h.service.cancel(terminalize);

    expect(h.repository.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "cancelled",
      expect.any(Number)
    );
    expect(terminalize).toHaveBeenCalledOnce();
    expect(h.repository.updateSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(
      terminalize.mock.invocationCallOrder[0]
    );
    expect(h.broadcast).not.toHaveBeenCalled();

    releaseIndex();
    await cancellation;
    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "cancelled" });
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

  it("leaves a session archived while its terminal projection was in flight", async () => {
    // Archive is admissible once the completion is recorded (no unfinished
    // message remains), and the reconcile runs after the D1 projection await.
    const h = harness({ session: createSession({ status: "archived" }) });

    await h.service.reconcileAfterExecution(true);

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("leaves a session cancelled while its terminal projection was in flight", async () => {
    const h = harness({ session: createSession({ status: "cancelled" }) });

    await h.service.reconcileAfterExecution(false);

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.reconcileAfterQueueRemoval", () => {
  it("leaves a cancelled session cancelled", async () => {
    const h = harness({ session: createSession({ status: "cancelled" }) });

    await h.service.reconcileAfterQueueRemoval();

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("preserves the latest failed execution outcome", async () => {
    const h = harness({ session: createSession({ status: "active" }) });
    h.repository.getLatestTerminalMessage.mockReturnValue({ status: "failed" } as MessageRow);

    await h.service.reconcileAfterQueueRemoval();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "failed" });
  });

  it("completes when no failed terminal message remains", async () => {
    const h = harness({ session: createSession({ status: "active" }) });
    h.repository.getLatestTerminalMessage.mockReturnValue({ status: "completed" } as MessageRow);

    await h.service.reconcileAfterQueueRemoval();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "completed" });
  });

  it("returns to created when no prompt has executed", async () => {
    const h = harness({ session: createSession({ status: "active" }) });

    await h.service.reconcileAfterQueueRemoval();

    expect(h.broadcast).toHaveBeenCalledWith({ type: "session_status", status: "created" });
  });

  it("does not transition while other work remains", async () => {
    const h = harness({ session: createSession({ status: "active" }) });
    h.repository.getPendingOrProcessingCount.mockReturnValue(1);

    await h.service.reconcileAfterQueueRemoval();

    expect(h.repository.updateSessionStatus).not.toHaveBeenCalled();
  });
});

describe("SessionStatusService.repairIndexStatus", () => {
  it("repairs a stale created index row", async () => {
    const h = harness({ session: createSession({ status: "completed" }) });

    await h.service.repairIndexStatus();

    expect(h.sessionIndex!.repairStatus).toHaveBeenCalledWith("public-session-1", "completed");
  });

  it("logs and propagates repair failures", async () => {
    const h = harness({ session: createSession({ status: "completed" }) });
    const error = new Error("d1 down");
    h.sessionIndex!.repairStatus.mockRejectedValue(error);

    await expect(h.service.repairIndexStatus()).rejects.toThrow(error);

    expect(h.log.error).toHaveBeenCalledWith(
      "session_index.update_status.background_error",
      expect.objectContaining({
        session_id: "public-session-1",
        status: "completed",
        error,
      })
    );
  });
});

describe("SessionStatusService.settleFromMessageState", () => {
  it("activates when work is pending", async () => {
    const h = harness({ session: createSession({ status: "created" }) });
    h.repository.getPendingOrProcessingCount.mockReturnValue(1);

    await expect(h.service.settleFromMessageState()).resolves.toBe("active");

    expect(h.repository.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "active",
      expect.any(Number)
    );
  });

  it("preserves failed as the latest terminal outcome", async () => {
    const h = harness({ session: createSession({ status: "created" }) });
    h.repository.getLatestTerminalMessage.mockReturnValue({ status: "failed" } as MessageRow);

    await expect(h.service.settleFromMessageState()).resolves.toBe("failed");

    expect(h.repository.updateSessionStatus).toHaveBeenCalledWith(
      "session-1",
      "failed",
      expect.any(Number)
    );
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

    const [parentId, path, init] = h.parentFetch.mock.calls[0];
    expect(parentId).toBe("parent-1");
    expect(path).toBe(SessionInternalPaths.childSessionUpdate);
    expect(JSON.parse(String(init?.body))).toEqual({
      childSessionId: "public-session-1",
      status: "active",
      title: "New title",
    });
    expect(h.backgroundTasks.submissions).toHaveLength(1);
  });

  it("logs (and does not throw) when the parent notification fails", async () => {
    const h = harness();
    h.parentFetch.mockRejectedValue(new Error("parent unreachable"));

    h.service.notifyParentOfChildUpdate(
      { parent_session_id: "parent-1", title: null },
      "public-session-1",
      { status: "failed", title: null }
    );

    // Drain the fire-and-forget notification; its failure is absorbed by the
    // boundary rather than thrown at the caller.
    await h.backgroundTasks.settle();

    expect(h.backgroundTasks.failures).toEqual([expect.any(Error)]);
  });

  it("is a no-op without a parent session id", () => {
    const h = harness();

    h.service.notifyParentOfChildUpdate({ parent_session_id: null, title: null }, "child-1", {
      status: "active",
      title: null,
    });

    expect(h.parentFetch).not.toHaveBeenCalled();
    expect(h.backgroundTasks.submissions).toHaveLength(0);
  });
});
