import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import { createTestBackgroundTasks } from "../../background-tasks.test-support";
import { SandboxRuntimeEventHandler } from "./runtime.handler";
import type { SandboxEventContext } from "./context";
import type { SessionDiffService } from "../diffs/service";
import type { EventRepository } from "../event-repository";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SandboxReadiness } from "../../sandbox/lifecycle/ports";

function createHandler() {
  const sandboxRepository = {
    updateSandboxHeartbeat: vi.fn(),
    recordReportedSandboxRuntimeVersion: vi.fn(),
    recordBootProgress: vi.fn(() => true),
    updateSandboxGitSyncStatus: vi.fn(),
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
  const lifecycle = { onRuntimeReady: vi.fn<SandboxReadiness["onRuntimeReady"]>(() => true) };
  const handler = new SandboxRuntimeEventHandler(
    repository as unknown as SessionCoreRepository,
    sandboxRepository,
    eventRepository as unknown as EventRepository,
    messenger,
    diffService as unknown as SessionDiffService,
    vi.fn((title: string) => ({ ok: true as const, title })),
    updateLastActivity,
    refreshSlackActivity,
    scheduleInactivityCheck,
    backgroundTasks,
    { processMessageQueue },
    log,
    lifecycle
  );
  return {
    handler,
    lifecycle,
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
  it("records the runtime fact, delegates readiness, then wakes work and arms inactivity", async () => {
    const h = createHandler();
    const order: string[] = [];
    h.broadcast.mockImplementation(() => {
      order.push("event");
    });
    h.lifecycle.onRuntimeReady.mockImplementation(() => {
      order.push("ready");
      return true;
    });
    h.processMessageQueue.mockImplementation(async () => {
      order.push("pump");
    });
    h.scheduleInactivityCheck.mockImplementation(async () => {
      order.push("inactivity");
    });

    await h.handler.handleReady(readyEvent, context);

    expect(h.lifecycle.onRuntimeReady).toHaveBeenCalledWith(5000, "opencode", undefined);
    expect(order).toEqual(["event", "ready", "pump", "inactivity"]);
    expect(h.updateLastActivity).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith({
      type: "sandbox_event",
      event: readyEvent,
    });
    expect(h.diffService.pinBaselines).toHaveBeenCalledWith(readyEvent);
    expect(h.sandboxRepository.recordReportedSandboxRuntimeVersion).toHaveBeenCalledWith(
      "v68-early-bridge-connect"
    );
    expect(h.eventRepository.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "ready" })
    );
  });

  it("passes shutdown protocol readiness through the lifecycle boundary", async () => {
    const h = createHandler();

    await h.handler.handleReady({ ...readyEvent, preservationProtocolVersion: 1 }, context);

    expect(h.lifecycle.onRuntimeReady).toHaveBeenCalledWith(5000, "opencode", 1);
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
  });

  it("does not wake or schedule work when the lifecycle owner rejects readiness", async () => {
    const h = createHandler();
    h.lifecycle.onRuntimeReady.mockReturnValue(false);

    await h.handler.handleReady(readyEvent, context);

    expect(h.eventRepository.createEvent).toHaveBeenCalledOnce();
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith({
      type: "sandbox_event",
      event: readyEvent,
    });
    expect(h.updateLastActivity).not.toHaveBeenCalled();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
    expect(h.backgroundTasks.submissions).toEqual([]);
    expect(h.processMessageQueue).not.toHaveBeenCalled();
  });

  it("delegates readiness and wakes work before a fallible inactivity schedule", async () => {
    const h = createHandler();
    h.scheduleInactivityCheck.mockRejectedValue(new Error("alarm unavailable"));

    await expect(h.handler.handleReady(readyEvent, context)).rejects.toThrow("alarm unavailable");

    expect(h.lifecycle.onRuntimeReady).toHaveBeenCalledOnce();
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.lifecycle.onRuntimeReady.mock.invocationCallOrder[0]).toBeLessThan(
      h.processMessageQueue.mock.invocationCallOrder[0]
    );
    expect(h.processMessageQueue.mock.invocationCallOrder[0]).toBeLessThan(
      h.scheduleInactivityCheck.mock.invocationCallOrder[0]
    );
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
