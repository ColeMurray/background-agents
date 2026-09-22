import { describe, expect, it, vi } from "vitest";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import { SandboxLifecycleManager, type SessionNoticeRecorder } from "./manager";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createUnmanagedShutdown,
} from "./test-helpers";
import type { CreateSandboxConfig, CreateSandboxResult, StopConfig } from "../provider";

/**
 * Replacing a generation whose bridge connected throws away that sandbox's
 * filesystem — uncommitted work, and the vendor session id that lives in it,
 * so the replacement answers with no conversation history. It is the most
 * expensive thing this lifecycle does and it used to be an info line, so from
 * the client the agent just continued with amnesia over a clean checkout.
 */
describe("reporting a spawn that discards a generation's state", () => {
  function fixture(
    options: {
      lastHeartbeat?: number | null;
      createSandbox?: (config: CreateSandboxConfig) => Promise<CreateSandboxResult>;
    } = {}
  ) {
    const order: string[] = [];
    const sandbox = createMockSandbox({
      status: "stopped" as SandboxStatus,
      snapshot_image_id: null,
      last_heartbeat:
        options.lastHeartbeat === undefined ? Date.now() - 10_000 : options.lastHeartbeat,
      created_at: Date.now() - 600_000,
    });
    const storage = createMockStorage(createMockSession(), sandbox);
    const notices: SessionNoticeRecorder = {
      recordWarning: vi.fn(() => order.push("notice")),
    };
    const provider = createMockProvider({
      capabilities: { supportsExplicitStop: true },
      stopSandbox: vi.fn(async (config: StopConfig) => {
        order.push(`stop:${config.reason}`);
        return { success: true };
      }),
      createSandbox:
        options.createSandbox ??
        vi.fn(async (config: CreateSandboxConfig) => {
          order.push("create");
          return {
            sandboxId: config.sandboxId,
            providerObjectId: "provider-obj-123",
            status: "connecting" as const,
            createdAt: Date.now(),
            lifetime: { kind: "none" as const, observedAtMs: Date.now() },
          };
        }),
    });
    const manager = new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      { ...createTestConfig(), notices }
    );
    return { manager, storage, sandbox, notices, order };
  }

  it("records the loss on the timeline, not just on the open sockets", async () => {
    const f = fixture();

    await f.manager.spawnSandbox();

    expect(f.notices.recordWarning).toHaveBeenCalledWith(
      expect.stringContaining("Uncommitted changes and earlier conversation context")
    );
  });

  // Announced before the replacement, the notice would claim a loss for a
  // spawn that never reached the point of causing one.
  it("records it only after the previous generation has actually been given up", async () => {
    const f = fixture();

    await f.manager.spawnSandbox();

    expect(f.order).toEqual(["stop:respawn", "notice", "create"]);
  });

  it("stays silent when the spawn never reaches the replacement boundary", async () => {
    const f = fixture();
    f.storage.getSession = vi.fn(() => null) as never;

    await f.manager.spawnSandbox();

    expect(f.notices.recordWarning).not.toHaveBeenCalled();
  });

  // A generation whose bridge never connected had nothing to lose.
  it("stays silent when the replaced generation never connected", async () => {
    const f = fixture({ lastHeartbeat: null });

    await f.manager.spawnSandbox();

    expect(f.notices.recordWarning).not.toHaveBeenCalled();
    expect(f.order).toEqual(["stop:respawn", "create"]);
  });

  // The loss is real as soon as the old generation is gone, so a replacement
  // that then fails must not swallow the notice.
  it("still records the loss when the replacement spawn fails", async () => {
    const f = fixture({
      createSandbox: vi.fn(async () => {
        throw new Error("provider rejected the spawn");
      }),
    });

    await f.manager.spawnSandbox();

    expect(f.notices.recordWarning).toHaveBeenCalledTimes(1);
  });
});
