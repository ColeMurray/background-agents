import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxEventContext } from "./context";
import { SandboxRuntimeEventHandler } from "./runtime.handler";

const INSTANCE_RESERVED_AT = 10_000;

function createHandler(opts: { becomesReady?: boolean } = {}) {
  const sandboxRepository = {
    updateSandboxHeartbeat: vi.fn(),
    recordReportedSandboxRuntimeVersion: vi.fn(),
    recordBootProgress: vi.fn(() => true),
    updateSandboxGitSyncStatus: vi.fn(),
    getSandbox: vi.fn(() => ({ instance_reserved_at: INSTANCE_RESERVED_AT })),
  };
  const updateLastActivity = vi.fn();
  const refreshSlackActivity = vi.fn();
  const scheduleInactivityCheck = vi.fn(async () => {});
  const backgroundTasks = {
    submit: vi.fn((task: () => Promise<void>) => {
      void task();
    }),
  };
  const messageQueue = {
    processMessageQueue: vi.fn(async () => {}),
    reconcileProcessingMessage: vi.fn(async (_activeMessageId?: string | null) => false),
  };
  const lifecycle = { onRuntimeReady: vi.fn(() => opts.becomesReady ?? true) };
  const handler = new SandboxRuntimeEventHandler(
    { getSession: () => null } as never,
    sandboxRepository as never,
    { createEvent: vi.fn() } as never,
    { broadcast: vi.fn() } as never,
    { pinBaselines: vi.fn() } as never,
    vi.fn() as never,
    updateLastActivity,
    refreshSlackActivity,
    scheduleInactivityCheck,
    backgroundTasks,
    messageQueue,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    lifecycle
  );
  return {
    handler,
    sandboxRepository,
    updateLastActivity,
    refreshSlackActivity,
    scheduleInactivityCheck,
    messageQueue,
    lifecycle,
  };
}

function context(processingMessage: SandboxEventContext["processingMessage"]): SandboxEventContext {
  return { now: 50_000, messageId: processingMessage?.id ?? null, processingMessage };
}

/** The reconciliation and wake run in a background task; let them settle. */
const settled = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const READY: Extract<SandboxEvent, { type: "ready" }> = {
  type: "ready",
  sandboxId: "sb-1",
  timestamp: 50,
  harness: "opencode",
};

describe("SandboxRuntimeEventHandler heartbeat", () => {
  it("renews activity and the Slack indicator for a prompt of the current instance", () => {
    const h = createHandler();

    h.handler.handleHeartbeat(context({ id: "msg-1", started_at: INSTANCE_RESERVED_AT }));

    expect(h.sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledWith(50_000);
    expect(h.updateLastActivity).toHaveBeenCalledWith(50_000);
    expect(h.refreshSlackActivity).toHaveBeenCalledWith("msg-1", 50_000);
  });

  it("records the heartbeat but renews nothing for a prompt of a replaced instance", () => {
    const h = createHandler();

    h.handler.handleHeartbeat(context({ id: "msg-1", started_at: INSTANCE_RESERVED_AT - 1 }));

    expect(h.sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledWith(50_000);
    expect(h.updateLastActivity).not.toHaveBeenCalled();
    expect(h.refreshSlackActivity).not.toHaveBeenCalled();
  });

  it("renews nothing while no prompt is processing", () => {
    const h = createHandler();

    h.handler.handleHeartbeat(context(null));

    expect(h.sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledWith(50_000);
    expect(h.updateLastActivity).not.toHaveBeenCalled();
  });
});

describe("SandboxRuntimeEventHandler ready", () => {
  it("commits readiness, then reconciles with the bridge's report and wakes the queue off the publication path", async () => {
    const h = createHandler({ becomesReady: true });

    await h.handler.handleReady({ ...READY, activeMessageId: null }, context(null));
    await settled();

    expect(h.lifecycle.onRuntimeReady).toHaveBeenCalledWith(50_000, "opencode", undefined);
    expect(h.messageQueue.reconcileProcessingMessage).toHaveBeenCalledWith(null);
    expect(h.lifecycle.onRuntimeReady.mock.invocationCallOrder[0]).toBeLessThan(
      h.messageQueue.reconcileProcessingMessage.mock.invocationCallOrder[0]
    );
    expect(h.messageQueue.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
  });

  it("passes a missing report through as no report", async () => {
    const h = createHandler({ becomesReady: true });

    await h.handler.handleReady(READY, context(null));
    await settled();

    expect(h.messageQueue.reconcileProcessingMessage).toHaveBeenCalledWith(undefined);
  });

  it("leaves the queue asleep on a reconnect that orphans nothing", async () => {
    const h = createHandler({ becomesReady: false });

    await h.handler.handleReady({ ...READY, activeMessageId: "msg-1" }, context(null));
    await settled();

    expect(h.messageQueue.reconcileProcessingMessage).toHaveBeenCalledWith("msg-1");
    expect(h.messageQueue.processMessageQueue).not.toHaveBeenCalled();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
  });

  it("wakes the queue, without re-arming inactivity, when a reconnect orphans a prompt", async () => {
    const h = createHandler({ becomesReady: false });
    h.messageQueue.reconcileProcessingMessage.mockResolvedValue(true);

    await h.handler.handleReady({ ...READY, activeMessageId: null }, context(null));
    await settled();

    expect(h.messageQueue.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
  });
});
