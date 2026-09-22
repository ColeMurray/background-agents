import { describe, expect, it, vi } from "vitest";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import { SandboxLifecycleManager } from "./manager";
import {
  createCheckpointShutdown,
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
} from "./test-helpers";
import type { StopConfig, StopResult } from "../provider";

/**
 * Both termination routes stop the provider with `intent: "destroy"` where the
 * provider cannot resume in place, which deletes the sandbox filesystem — the
 * uncommitted work and the vendor session id that carries the conversation
 * history with it. The idle and heartbeat routes snapshot first; these did not,
 * so a prompt-send failure or a fatal runtime report silently cost the session
 * everything it had not pushed.
 */
describe("preserving a serving generation before a destructive termination", () => {
  function fixture(
    options: {
      status?: SandboxStatus;
      supportsPersistentResume?: boolean;
      takeSnapshot?: (...args: unknown[]) => Promise<{ success: boolean; imageId?: string }>;
    } = {}
  ) {
    const order: string[] = [];
    const sandbox = createMockSandbox({ status: options.status ?? ("ready" as SandboxStatus) });
    const storage = createMockStorage(createMockSession(), sandbox);
    const broadcaster = createMockBroadcaster();
    const stops: StopConfig[] = [];
    const provider = createMockProvider({
      capabilities: {
        supportsExplicitStop: true,
        supportsSnapshots: true,
        supportsPersistentResume: options.supportsPersistentResume ?? false,
      },
      stopSandbox: vi.fn(async (config: StopConfig): Promise<StopResult> => {
        order.push(`stop:${config.intent}`);
        stops.push(config);
        return { success: true };
      }),
      takeSnapshot: vi.fn(async () => {
        order.push("snapshot");
        return options.takeSnapshot
          ? await options.takeSnapshot()
          : { success: true, imageId: "snapshot-img-123" };
      }) as never,
    });
    const shutdown = createCheckpointShutdown(provider, storage, broadcaster);
    const manager = new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      broadcaster,
      createMockWebSocketManager(true),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      shutdown,
      createTestConfig()
    );
    return { manager, storage, sandbox, provider, stops, order, shutdown };
  }

  it("snapshots before destroying an unresponsive serving sandbox", async () => {
    const f = fixture();

    await f.manager.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");

    expect(f.order).toEqual(["snapshot", "stop:destroy"]);
    expect(f.sandbox.snapshot_image_id).toBe("snapshot-img-123");
  });

  it("snapshots before destroying a sandbox that reported a fatal runtime error", async () => {
    const f = fixture();

    await expect(f.manager.terminateFailedSandbox("OpenCode crashed")).resolves.toBe(true);

    expect(f.order).toEqual(["snapshot", "stop:destroy"]);
    expect(f.sandbox.snapshot_image_id).toBe("snapshot-img-123");
  });

  it("does not snapshot when the provider keeps its own state across the stop", async () => {
    const f = fixture({ supportsPersistentResume: true });

    await f.manager.terminateUnresponsiveSandbox("stop_confirmation_timeout");

    expect(f.order).toEqual(["stop:preserve"]);
    expect(f.sandbox.snapshot_image_id).toBeNull();
  });

  // A generation whose bridge never served has nothing to preserve, and its
  // filesystem is whatever its boot left behind — restoring it would re-run the
  // same broken boot on every replacement.
  it("does not snapshot a generation that never finished booting", async () => {
    const f = fixture({ status: "connecting" as SandboxStatus });

    await expect(f.manager.terminateFailedSandbox("setup.sh exited 1")).resolves.toBe(true);

    expect(f.order).toEqual(["stop:destroy"]);
    expect(f.sandbox.snapshot_image_id).toBeNull();
  });

  // The destruction is permitted by a durable recovery point, so a checkpoint
  // whose outcome is unknown holds it rather than destroying the only copy.
  it("holds the destructive stop when the checkpoint outcome is unknown", async () => {
    const f = fixture({
      takeSnapshot: async () => {
        throw new Error("provider snapshot failed");
      },
    });

    await f.manager.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");

    expect(f.order).toEqual(["snapshot"]);
    expect(f.stops).toEqual([]);
  });
});
