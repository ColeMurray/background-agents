import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../logger";
import type { BackgroundTasks } from "../../platform-ports";
import type { SessionDiffService } from "../diffs/service";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SandboxRow } from "../types";
import { SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS } from "../websocket-manager";
import { SandboxRuntimeEventHandler } from "./runtime.handler";

const NOW = 100_000;

function setup() {
  const sandbox = {
    modal_sandbox_id: "sandbox-1",
    created_at: 1,
    status: "ready",
    last_heartbeat: NOW,
  } as SandboxRow;
  const sandboxRepository = {
    getSandbox: vi.fn((): SandboxRow | null => sandbox),
    updateSandboxHeartbeat: vi.fn((timestamp: number) => {
      sandbox.last_heartbeat = timestamp;
    }),
    recordReportedSandboxRuntimeVersion: vi.fn(),
    recordBootProgress: vi.fn(() => true),
    updateSandboxGitSyncStatus: vi.fn(),
  };
  const messenger = { broadcast: vi.fn() };
  const alarmScheduler = {
    schedule: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    current: vi.fn().mockResolvedValue(null),
  };
  const lifecycle = {
    onRuntimeReady: vi.fn(() => {
      sandbox.status = "ready";
      return true;
    }),
  };
  const backgroundTasks = { submit: vi.fn<BackgroundTasks["submit"]>() };
  const messageQueue = { processMessageQueue: vi.fn().mockResolvedValue(undefined) };
  const log = { warn: vi.fn(), error: vi.fn() };
  const commands = {
    flush: vi.fn().mockResolvedValue(undefined),
    recordProtocol: vi.fn(),
    supportsReplay: vi.fn(() => false),
    hasUnacknowledgedPrompt: vi.fn(() => false),
  };
  const scheduleInactivityCheck = vi.fn().mockResolvedValue(undefined);
  const handler = new SandboxRuntimeEventHandler(
    { getSession: vi.fn(() => null) } as unknown as SessionCoreRepository,
    sandboxRepository,
    { createEvent: vi.fn() } as unknown as EventRepository,
    messenger as unknown as SessionMessenger,
    { pinBaselines: vi.fn() } as unknown as SessionDiffService,
    vi.fn(),
    vi.fn(),
    vi.fn(),
    scheduleInactivityCheck,
    backgroundTasks,
    messageQueue,
    log as unknown as Logger,
    lifecycle,
    commands,
    alarmScheduler
  );
  return {
    handler,
    sandbox,
    sandboxRepository,
    messenger,
    alarmScheduler,
    lifecycle,
    commands,
    log,
    backgroundTasks,
    messageQueue,
    scheduleInactivityCheck,
  };
}

describe("SandboxRuntimeEventHandler connection health", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(["ready", "snapshotting"] as const)("%s sandbox", (status) => {
    it.each([0, SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS - 1])(
      "schedules the heartbeat deadline at age %i without warning",
      async (age) => {
        const h = setup();
        h.sandbox.status = status;
        h.sandbox.last_heartbeat = NOW - age;

        await h.handler.checkConnectionHealth();

        expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(
          NOW - age + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS
        );
        expect(h.messenger.broadcast).not.toHaveBeenCalled();
      }
    );

    it.each([
      NOW - SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS,
      NOW - SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS - 1,
      null,
    ])("warns for heartbeat %s without rearming a past alarm", async (heartbeat) => {
      const h = setup();
      h.sandbox.status = status;
      h.sandbox.last_heartbeat = heartbeat;

      await h.handler.checkConnectionHealth();

      expect(h.messenger.broadcast).toHaveBeenCalledExactlyOnceWith({
        type: "sandbox_connection",
        status: "reconnecting",
      });
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
    });
  });

  it.each(["pending", "spawning", "connecting", "warming", "stale", "stopped", "failed"] as const)(
    "neither schedules nor broadcasts for %s",
    async (status) => {
      const h = setup();
      h.sandbox.status = status;
      h.sandbox.last_heartbeat = null;

      await h.handler.checkConnectionHealth();

      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.messenger.broadcast).not.toHaveBeenCalled();
    }
  );

  it("neither schedules nor broadcasts without a sandbox", async () => {
    const h = setup();
    h.sandboxRepository.getSandbox.mockReturnValue(null);

    await h.handler.checkConnectionHealth();

    expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
    expect(h.messenger.broadcast).not.toHaveBeenCalled();
  });

  it("retargets an older alarm to the newer heartbeat deadline", async () => {
    const h = setup();
    const oldDeadline = NOW + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS;
    await h.handler.checkConnectionHealth();
    expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(oldDeadline);
    h.alarmScheduler.schedule.mockClear();

    h.sandbox.last_heartbeat = NOW + 10_000;
    vi.mocked(Date.now).mockReturnValue(oldDeadline);
    await h.handler.checkConnectionHealth();

    expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(oldDeadline + 10_000);
    expect(h.messenger.broadcast).not.toHaveBeenCalled();
  });

  it.each(["ready", "spawning", "stopped"] as const)(
    "reads a replacement generation in %s status when an old alarm fires",
    async (status) => {
      const h = setup();
      const oldDeadline = NOW + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS;
      await h.handler.checkConnectionHealth();
      h.alarmScheduler.schedule.mockClear();
      h.sandboxRepository.getSandbox.mockReturnValue({
        ...h.sandbox,
        modal_sandbox_id: "sandbox-2",
        created_at: oldDeadline,
        status,
        last_heartbeat: status === "ready" ? oldDeadline : null,
      });
      vi.mocked(Date.now).mockReturnValue(oldDeadline);

      await h.handler.checkConnectionHealth();

      expect(h.messenger.broadcast).not.toHaveBeenCalled();
      if (status === "ready") {
        expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(
          oldDeadline + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS
        );
      } else {
        expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      }
    }
  );

  it.each([null, { id: "message-1" }])(
    "persists heartbeat receipt time and checks the threshold with processingMessage=%j",
    async (processingMessage) => {
      const h = setup();
      h.sandbox.last_heartbeat = null;
      const receivedAt = NOW - 10;
      const deadline = receivedAt + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS;

      await h.handler.handleHeartbeat({
        now: receivedAt,
        messageId: processingMessage?.id ?? null,
        processingMessage,
      });

      expect(h.sandboxRepository.updateSandboxHeartbeat).toHaveBeenCalledExactlyOnceWith(
        receivedAt
      );
      expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(deadline);
      expect(h.messenger.broadcast).toHaveBeenCalledExactlyOnceWith({
        type: "sandbox_connection",
        status: "connected",
      });
      h.alarmScheduler.schedule.mockClear();
      h.messenger.broadcast.mockClear();

      vi.mocked(Date.now).mockReturnValue(deadline - 1);
      await h.handler.checkConnectionHealth();
      expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(deadline);
      expect(h.messenger.broadcast).not.toHaveBeenCalled();
      h.alarmScheduler.schedule.mockClear();

      vi.mocked(Date.now).mockReturnValue(deadline);
      await h.handler.checkConnectionHealth();
      expect(h.messenger.broadcast).toHaveBeenCalledExactlyOnceWith({
        type: "sandbox_connection",
        status: "reconnecting",
      });
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
    }
  );

  it.each([true, false])("ready schedules even when becameReady=%s", async (becameReady) => {
    const h = setup();
    h.sandbox.last_heartbeat = NOW - 1_000;
    if (becameReady) {
      h.sandbox.status = "connecting";
    } else {
      h.lifecycle.onRuntimeReady.mockReturnValue(false);
    }

    await h.handler.handleReady(
      { type: "ready", sandboxId: "sandbox-1", timestamp: 1 },
      { now: NOW, messageId: null, processingMessage: null }
    );

    expect(h.lifecycle.onRuntimeReady).toHaveBeenCalledExactlyOnceWith(NOW, undefined, undefined);
    expect(h.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(
      NOW - 1_000 + SANDBOX_COMMAND_HEARTBEAT_TIMEOUT_MS
    );
    expect(h.messenger.broadcast).toHaveBeenCalledWith({
      type: "sandbox_connection",
      status: "connected",
    });
    expect(h.messenger.broadcast).not.toHaveBeenCalledWith({
      type: "sandbox_connection",
      status: "reconnecting",
    });
  });

  describe.each([true, false])("ready follow-up failures with becameReady=%s", (becameReady) => {
    it.each(["health", "flush"] as const)(
      "preserves queue submission after %s fails",
      async (failure) => {
        const h = setup();
        h.lifecycle.onRuntimeReady.mockReturnValue(becameReady);
        const error = new Error("Injected follow-up failure");
        if (failure === "health") h.alarmScheduler.schedule.mockRejectedValueOnce(error);
        else h.commands.flush.mockRejectedValueOnce(error);

        await expect(
          h.handler.handleReady(
            { type: "ready", sandboxId: "sandbox-1", timestamp: NOW },
            { now: NOW, messageId: null, processingMessage: null }
          )
        ).resolves.toBeUndefined();

        expect(h.commands.flush).toHaveBeenCalledOnce();
        expect(h.log.error).toHaveBeenCalledExactlyOnceWith(
          failure === "health"
            ? "sandbox.connection_health_check_failed"
            : "sandbox.ready.command_replay_failed",
          { error_type: "Error" }
        );
        expect(h.backgroundTasks.submit).toHaveBeenCalledTimes(becameReady ? 1 : 0);
        expect(h.scheduleInactivityCheck).toHaveBeenCalledTimes(becameReady ? 1 : 0);
        if (becameReady) {
          const [task, metadata] = h.backgroundTasks.submit.mock.calls[0];
          expect(metadata).toEqual({ name: "message_queue.process" });
          await task();
          expect(h.messageQueue.processMessageQueue).toHaveBeenCalledOnce();
        }
      }
    );
  });
});
