import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { createTestBackgroundTasks } from "../../background-tasks.test-support";
import { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxEventContext } from "./context";
import type { SessionDiffService } from "../diffs/service";
import type { EventRepository } from "../event-repository";
import type { SandboxRepository } from "../sandbox-repository";
import type { SessionCoreRepository } from "../session-core-repository";

function createHandler() {
  const sandboxRepository = {
    getSandbox: vi.fn(() => ({ modal_sandbox_id: "sb-1", created_at: 4000 })),
    updateSandboxHeartbeat: vi.fn(),
    recordReportedSandboxRuntimeVersion: vi.fn(),
    markSandboxReady: vi.fn(() => true),
    recordBootProgress: vi.fn(() => true),
  };
  const repository = { getSession: vi.fn(() => ({ harness: "opencode" })) };
  const eventRepository = { createEvent: vi.fn() };
  const broadcast = vi.fn((_message: ServerMessage) => {});
  const messenger = { broadcast, sendToSandbox: vi.fn(async () => {}) };
  const diffService = { pinBaselines: vi.fn() };
  const updateLastActivity = vi.fn();
  const refreshSlackActivity = vi.fn();
  const scheduleInactivityCheck = vi.fn(async () => {});
  const backgroundTasks = createTestBackgroundTasks();
  const processMessageQueue = vi.fn(async () => {});
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  const handler = new SandboxRuntimeEventHandler(
    repository as unknown as SessionCoreRepository,
    sandboxRepository as unknown as SandboxRepository,
    eventRepository as unknown as EventRepository,
    messenger,
    diffService as unknown as SessionDiffService,
    vi.fn((title: string) => ({ ok: true as const, title })),
    updateLastActivity,
    refreshSlackActivity,
    scheduleInactivityCheck,
    backgroundTasks,
    { processMessageQueue },
    log
  );
  return {
    handler,
    sandboxRepository,
    eventRepository,
    broadcast,
    diffService,
    updateLastActivity,
    scheduleInactivityCheck,
    backgroundTasks,
    processMessageQueue,
    log,
  };
}

const context: SandboxEventContext = { now: 5000, messageId: null, processingMessage: null };

const readyEvent: Extract<SandboxEvent, { type: "ready" }> = {
  type: "ready",
  harness: "opencode",
  runtimeVersion: "v68-early-bridge-connect",
  sandboxId: "sb-1",
  timestamp: 5,
};

describe("SandboxRuntimeEventHandler.handleReady", () => {
  it("flips a booting sandbox to ready, stamps activity, arms inactivity, broadcasts and pumps the queue", async () => {
    const h = createHandler();

    await h.handler.handleReady(readyEvent, context);

    expect(h.sandboxRepository.markSandboxReady).toHaveBeenCalledWith({
      sandboxId: "sb-1",
      createdAt: 4000,
    });
    expect(h.updateLastActivity).toHaveBeenCalledWith(5000);
    expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
    expect(h.broadcast.mock.calls.map(([message]) => message.type)).toEqual([
      "sandbox_event",
      "sandbox_status",
    ]);
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_status", status: "ready" });
    expect(h.backgroundTasks.submissions.map((submission) => submission.name)).toEqual([
      "message_queue.process",
    ]);
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    // Unchanged duties of the ready event.
    expect(h.diffService.pinBaselines).toHaveBeenCalledWith(readyEvent);
    expect(h.sandboxRepository.recordReportedSandboxRuntimeVersion).toHaveBeenCalledWith(
      "v68-early-bridge-connect"
    );
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ready" })
    );
  });

  it("is transition-only: a repeat ready from an already-ready, stopped, stale, fenced or replaced row changes nothing", async () => {
    const h = createHandler();
    h.sandboxRepository.markSandboxReady.mockReturnValue(false);

    await h.handler.handleReady(readyEvent, context);

    expect(h.updateLastActivity).not.toHaveBeenCalled();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
    expect(h.broadcast.mock.calls.map(([message]) => message.type)).toEqual(["sandbox_event"]);
    expect(h.backgroundTasks.submissions).toEqual([]);
    expect(h.processMessageQueue).not.toHaveBeenCalled();
    // The timeline still records the event: it is a fact about the runtime.
    expect(h.eventRepository.createEvent).toHaveBeenCalledOnce();
  });

  it("commits and publishes readiness before arming the inactivity check", async () => {
    // The bridge does not resend ready unless it reconnects, so the durable
    // transition and its publication cannot sit behind a fallible step.
    const h = createHandler();
    const order: string[] = [];
    h.sandboxRepository.markSandboxReady.mockImplementation(() => {
      order.push("ready");
      return true;
    });
    h.broadcast.mockImplementation((message) => {
      if (message.type === "sandbox_status") order.push("broadcast");
    });
    h.processMessageQueue.mockImplementation(async () => {
      order.push("pump");
    });
    h.scheduleInactivityCheck.mockImplementation(async () => {
      order.push("inactivity");
    });

    await h.handler.handleReady(readyEvent, context);

    expect(order).toEqual(["ready", "broadcast", "pump", "inactivity"]);
  });

  it("keeps the sandbox ready, published and pumping when the inactivity check cannot be armed", async () => {
    // An alarm is always pending while a bridge is attached (the disconnect
    // check armed at attach, re-armed by every alarm run), so a failed arm
    // here costs nothing but the error it surfaces.
    const h = createHandler();
    h.scheduleInactivityCheck.mockRejectedValue(new Error("alarm unavailable"));

    await expect(h.handler.handleReady(readyEvent, context)).rejects.toThrow("alarm unavailable");

    expect(h.sandboxRepository.markSandboxReady).toHaveBeenCalledOnce();
    expect(h.updateLastActivity).toHaveBeenCalledWith(5000);
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_status", status: "ready" });
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
  });

  it("records the event but moves nothing when there is no sandbox row to own it", async () => {
    const h = createHandler();
    h.sandboxRepository.getSandbox.mockReturnValue(null as never);

    await h.handler.handleReady(readyEvent, context);

    expect(h.eventRepository.createEvent).toHaveBeenCalledOnce();
    expect(h.sandboxRepository.markSandboxReady).not.toHaveBeenCalled();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
    expect(h.processMessageQueue).not.toHaveBeenCalled();
  });
});

describe("SandboxRuntimeEventHandler.handleBootProgress", () => {
  const progress: Extract<SandboxEvent, { type: "boot_progress" }> = {
    type: "boot_progress",
    bootSeq: 3,
    phase: "setup",
    status: "started",
    repoOwner: "acme",
    repoName: "api",
    sandboxId: "sb-1",
    timestamp: 5,
  };

  it("records the phase, lands it on the timeline and broadcasts it", () => {
    const h = createHandler();

    h.handler.handleBootProgress(progress, context);

    // The stored phase is the event minus its envelope, so the snapshot can
    // hand a client everything the timeline copy carries.
    expect(h.sandboxRepository.recordBootProgress).toHaveBeenCalledWith(
      {
        bootSeq: 3,
        phase: "setup",
        status: "started",
        repoOwner: "acme",
        repoName: "api",
        sandboxId: "sb-1",
      },
      3
    );
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "boot_progress" })
    );
    expect(h.broadcast).toHaveBeenCalledWith({ type: "sandbox_event", event: progress });
  });

  it("drops a phase already seen under the same or a later sequence", () => {
    const h = createHandler();
    h.sandboxRepository.recordBootProgress.mockReturnValue(false);

    h.handler.handleBootProgress(progress, context);

    expect(h.eventRepository.createEvent).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it("carries a tolerated hook failure as a warning on the phase", () => {
    const h = createHandler();

    h.handler.handleBootProgress({ ...progress, status: "completed", warning: true }, context);

    expect(h.sandboxRepository.recordBootProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed", warning: true }),
      3
    );
  });
});
