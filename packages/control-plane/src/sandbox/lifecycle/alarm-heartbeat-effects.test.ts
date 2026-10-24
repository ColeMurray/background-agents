import { afterEach, describe, it, expect, vi } from "vitest";
import { createAlarmHandler } from "../../session/alarm/handler";
import { createAlarmFixture, createMockSandbox, createMockProvider } from "./test-helpers";

const HEARTBEAT_LOST = { kind: "heartbeat_lost", reason: "The sandbox stopped responding." };

describe("heartbeat watchdog effects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fails the running prompt when the heartbeat save cannot be confirmed", async () => {
    // The capture's answer is lost, so the coordinator holds the source for
    // recovery and no stop follows. The prompt that runtime was serving must
    // not wait on that hold: nothing else fails it, and the hold keeps every
    // later alarm away from the execution timeout. The queue stays parked.
    const sandbox = createMockSandbox({ last_heartbeat: Date.now() - 100_000 });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true },
        takeSnapshot: vi.fn(async () => {
          throw new Error("checkpoint response lost");
        }),
        stopSandbox,
      })
    );
    const messageQueue = {
      failStuckProcessingMessage: vi.fn(async () => {}),
      failPendingMessage: vi.fn(async () => {}),
    };
    const executionStop = {
      recoverStopConfirmationTimeout: vi.fn(async () => {}),
      resumeAfterSandboxTermination: vi.fn(async () => {}),
    };
    const handler = createAlarmHandler({
      repository: {
        // Well inside its execution budget: only the watchdog can end it.
        getProcessingMessageWithStartedAt: () => ({ id: "msg-running", started_at: Date.now() }),
        getNextPendingMessage: () => ({ id: "msg-queued" }),
      },
      messageQueue,
      executionStop,
      lifecycleManager: h.manager,
      terminalMessageProjection: { flushPending: vi.fn(async () => {}) },
      alarmScheduler: h.alarmScheduler,
      getExecutionTimeoutMs: () => 60_000,
      now: () => Date.now(),
      log: { warn: vi.fn() },
    } as never);

    await handler.handle();

    expect(messageQueue.failStuckProcessingMessage).toHaveBeenCalledExactlyOnceWith(
      HEARTBEAT_LOST.reason
    );
    expect(executionStop.resumeAfterSandboxTermination).not.toHaveBeenCalled();
    // No boot was abandoned: the queued prompt waits for recovery.
    expect(messageQueue.failPendingMessage).not.toHaveBeenCalled();
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("stale");
    expect(h.shutdown.isHolding()).toBe(true);
    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");
  });

  it("leaves a replacement admitted during a lost heartbeat save alone", async () => {
    const sandbox = createMockSandbox({ last_heartbeat: Date.now() - 100_000 });
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({
        capabilities: { supportsExplicitStop: true },
        takeSnapshot: vi.fn(async () => {
          sandbox.modal_sandbox_id = "replacement-sandbox";
          sandbox.modal_object_id = "replacement-provider-object";
          sandbox.created_at += 1;
          sandbox.status = "connecting";
          throw new Error("checkpoint response lost");
        }),
        stopSandbox,
      })
    );

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("connecting");
  });

  describe("providers whose snapshots stop the source", () => {
    it.each([
      { ownership: "held", result: HEARTBEAT_LOST },
      { ownership: "owned", result: "no_action" },
    ] as const)(
      "reports $result after the emergency shutdown answers $ownership",
      async ({ ownership, result }) => {
        // "owned" fails the prompt inside the shutdown's own claim; "held" means
        // a save already owns the source and nothing will.
        const sandbox = createMockSandbox({ last_heartbeat: Date.now() - 100_000 });
        const h = createAlarmFixture(
          sandbox,
          createMockProvider({
            capabilities: { snapshotRequiresShutdown: true, supportsExplicitStop: true },
          })
        );
        const requestShutdown = vi
          .spyOn(h.shutdown, "requestShutdown")
          .mockResolvedValue(ownership);

        await expect(h.manager.handleAlarm()).resolves.toEqual(result);

        expect(requestShutdown).toHaveBeenCalledExactlyOnceWith("heartbeat_timeout", "emergency");
        expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
        expect(h.wsManager.detachSandboxWebSocket).not.toHaveBeenCalled();
        expect(sandbox.status).toBe("ready");
      }
    );
  });
});
