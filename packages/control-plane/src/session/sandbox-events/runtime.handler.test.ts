import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import type { BackgroundTasks } from "../../platform-ports";
import type { SandboxReadiness } from "../../sandbox/lifecycle/ports";
import type { SessionMessageQueue } from "../message-queue";
import { SandboxRuntimeEventHandler } from "./runtime.handler";

function createHandler(onRuntimeReady: () => boolean) {
  const reconcileProcessingMessage = vi.fn(async () => false);
  const processMessageQueue = vi.fn(async () => {});
  let queued: Promise<void> = Promise.resolve();
  const backgroundTasks: BackgroundTasks = {
    submit(task) {
      queued = Promise.resolve(task()).then(() => undefined);
    },
  };
  const scheduleInactivityCheck = vi.fn(async () => {});
  const handler = new SandboxRuntimeEventHandler(
    { getSession: () => ({ harness: "opencode" }) } as never,
    {
      recordReportedSandboxRuntimeVersion: vi.fn(),
      updateSandboxHeartbeat: vi.fn(),
      recordBootProgress: vi.fn(),
      updateSandboxGitSyncStatus: vi.fn(),
    } as never,
    { createEvent: vi.fn() } as never,
    { broadcast: vi.fn() } as never,
    { pinBaselines: vi.fn() } as never,
    vi.fn() as never,
    vi.fn(),
    vi.fn(),
    scheduleInactivityCheck,
    backgroundTasks,
    {
      reconcileProcessingMessage,
      processMessageQueue,
    } as Pick<SessionMessageQueue, "processMessageQueue" | "reconcileProcessingMessage">,
    { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger,
    { onRuntimeReady } as unknown as SandboxReadiness
  );
  return {
    handler,
    reconcileProcessingMessage,
    processMessageQueue,
    scheduleInactivityCheck,
    queued: () => queued,
  };
}

const ready = {
  type: "ready" as const,
  sandboxId: "sb-1",
  timestamp: 1,
  harness: "opencode" as const,
};

describe("SandboxRuntimeEventHandler.handleReady", () => {
  it("fails an orphaned prompt from the bridge report and then pumps the queue", async () => {
    const h = createHandler(() => true);
    h.reconcileProcessingMessage.mockResolvedValue(true);

    await h.handler.handleReady(
      { ...ready, activeMessageId: null },
      { now: 10, messageId: null, processingMessage: null }
    );
    await h.queued();

    expect(h.reconcileProcessingMessage).toHaveBeenCalledWith({ owedMessageId: null });
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
  });

  it("passes no report when the runtime omits activeMessageId", async () => {
    const h = createHandler(() => true);

    await h.handler.handleReady(ready, { now: 10, messageId: null, processingMessage: null });
    await h.queued();

    expect(h.reconcileProcessingMessage).toHaveBeenCalledWith(undefined);
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
  });

  it("wakes the queue for an orphaned prompt even when readiness did not take effect", async () => {
    const h = createHandler(() => false);
    h.reconcileProcessingMessage.mockResolvedValue(true);

    await h.handler.handleReady(
      { ...ready, activeMessageId: "msg-held" },
      { now: 10, messageId: null, processingMessage: { id: "msg-old" } }
    );
    await h.queued();

    expect(h.reconcileProcessingMessage).toHaveBeenCalledWith({ owedMessageId: "msg-held" });
    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
  });

  it("still pumps the queue when reconciliation fails", async () => {
    const h = createHandler(() => true);
    h.reconcileProcessingMessage.mockRejectedValue(new Error("status projection failed"));

    await h.handler.handleReady(
      { ...ready, activeMessageId: null },
      { now: 10, messageId: null, processingMessage: null }
    );
    await h.queued();

    expect(h.processMessageQueue).toHaveBeenCalledOnce();
    expect(h.scheduleInactivityCheck).toHaveBeenCalledOnce();
  });

  it("does not pump a repeated ready that orphaned nothing", async () => {
    const h = createHandler(() => false);

    await h.handler.handleReady(
      { ...ready, activeMessageId: "msg-held" },
      { now: 10, messageId: null, processingMessage: { id: "msg-held" } }
    );
    await h.queued();

    expect(h.processMessageQueue).not.toHaveBeenCalled();
    expect(h.scheduleInactivityCheck).not.toHaveBeenCalled();
  });
});
