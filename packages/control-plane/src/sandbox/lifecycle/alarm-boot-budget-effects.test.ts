import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import type { StopResult } from "../provider";
import { createAlarmFixture, createMockSandbox, createMockProvider } from "./test-helpers";

describe("boot budget alarm effects", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shuts down before fencing and failing the generation, then publishes the persisted phase error", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs,
      boot_phase: JSON.stringify({
        phase: "setup",
        status: "started",
        repoOwner: "acme",
        repoName: "api",
      }),
      code_server_url: "https://code.test",
    });
    const h = createAlarmFixture(sandbox);
    vi.mocked(h.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    const order: string[] = [];
    vi.mocked(h.wsManager.sendToSandbox).mockImplementation((message) => {
      order.push(`send:${(message as { type: string }).type}`);
      return true;
    });
    vi.mocked(h.storage.fenceSandboxGeneration).mockImplementation(() => {
      order.push("fence");
      sandbox.fenced = 1;
      sandbox.auth_token_hash = "";
      sandbox.active_socket_id = "";
    });
    vi.mocked(h.storage.updateSandboxStatus).mockImplementation((status) => {
      order.push(`status:${status}`);
      sandbox.status = status;
    });

    const result = await h.manager.handleAlarm();

    expect(result).toEqual({
      kind: "boot_budget_exceeded",
      reason: expect.stringContaining("SANDBOX_BOOT_TIMEOUT_MS"),
    });
    // Shutdown must go out while the socket is adoptable; sends refuse failed rows.
    expect(order).toEqual(["send:shutdown", "fence", "status:failed"]);
    expect(sandbox.fenced).toBe(1);
    expect(sandbox.auth_token_hash).toBe("");
    expect(sandbox.spawn_failure_count).toBe(1);
    expect(sandbox.code_server_url).toBeNull();
    expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledWith(1000, "Boot budget exceeded");
    expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "failed" });
    expect(sandbox.last_spawn_error).toContain("30 minutes");
    expect(sandbox.last_spawn_error).toContain("setup.sh");
    expect(sandbox.last_spawn_error).toContain("acme/api");
    expect(h.broadcaster.messages).toContainEqual({
      type: "sandbox_error",
      error: sandbox.last_spawn_error,
    });
  });

  it("blocks actual replacement and repeat alarms during a budget stop without overwriting the failure", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs,
    });
    let releaseStop!: (result: StopResult) => void;
    const stopSandbox = vi.fn(
      () =>
        new Promise<StopResult>((resolve) => {
          releaseStop = resolve;
        })
    );
    const h = createAlarmFixture(
      sandbox,
      createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
    );
    const pending = h.manager.handleAlarm();
    let reason: string | null = null;

    try {
      await vi.waitFor(() => expect(stopSandbox).toHaveBeenCalledOnce());
      reason = sandbox.last_spawn_error;
      expect(reason).toContain("Sandbox boot exceeded");
      expect(h.manager.isSpawning()).toBe(true);
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "failed" });
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_error", error: reason });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledOnce();
      const messages = [...h.broadcaster.messages];

      await h.manager.spawnSandbox();
      await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

      expect(h.storage.updateSandboxForSpawn).not.toHaveBeenCalled();
      expect(h.storage.updateSandboxForResume).not.toHaveBeenCalled();
      expect(h.provider.createSandbox).not.toHaveBeenCalled();
      expect(h.provider.restoreFromSnapshot).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.storage.setLastSpawnError).toHaveBeenCalledExactlyOnceWith(
        reason,
        expect.any(Number)
      );
      expect(sandbox.last_spawn_error).toBe(reason);
      expect(sandbox.spawn_failure_count).toBe(1);
      expect(h.broadcaster.messages).toEqual(messages);
      expect(stopSandbox).toHaveBeenCalledExactlyOnceWith({
        providerObjectId: sandbox.modal_object_id,
        sessionId: "test-session",
        reason: "boot_budget_exceeded",
        intent: "destroy",
        signal: undefined,
      });
      expect(h.wsManager.sendToSandbox).toHaveBeenCalledExactlyOnceWith({ type: "shutdown" });
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledOnce();
    } finally {
      releaseStop({ success: true });
      await pending;
    }

    await expect(pending).resolves.toEqual({ kind: "boot_budget_exceeded", reason });
    expect(h.manager.isSpawning()).toBe(false);
    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");
    expect(h.storage.incrementCircuitBreakerFailure).toHaveBeenCalledOnce();
    expect(h.storage.setLastSpawnError).toHaveBeenCalledOnce();
    expect(stopSandbox).toHaveBeenCalledOnce();
  });

  it.each(["rejected", "unsuccessful"] as const)(
    "preserves the budget failure after a %s provider stop",
    async (failure) => {
      const sandbox = createMockSandbox({
        status: "connecting",
        created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs,
        code_server_url: "https://code.test",
      });
      const stopSandbox = vi.fn(async () => {
        if (failure === "rejected") throw new Error("provider stop unavailable");
        return { success: false, error: "provider stop unavailable" };
      });
      const stopLog = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = createAlarmFixture(
        sandbox,
        createMockProvider({ capabilities: { supportsExplicitStop: true }, stopSandbox })
      );

      const result = await h.manager.handleAlarm();

      expect(result).toEqual({
        kind: "boot_budget_exceeded",
        reason: sandbox.last_spawn_error,
      });

      expect(stopSandbox).toHaveBeenCalledOnce();
      expect(stopLog).toHaveBeenCalledWith(
        expect.stringContaining('"error":"provider stop unavailable"')
      );
      expect(sandbox.code_server_url).toBeNull();
      expect(sandbox.status).toBe("failed");
      expect(sandbox.fenced).toBe(1);
      expect(sandbox.last_spawn_error).toContain("Sandbox boot exceeded");
      expect(sandbox.last_spawn_error).not.toContain("provider stop unavailable");
      expect(h.broadcaster.messages).toContainEqual({ type: "sandbox_status", status: "failed" });
      expect(h.broadcaster.messages).toContainEqual({
        type: "sandbox_error",
        error: sandbox.last_spawn_error,
      });
      expect(h.manager.isSpawning()).toBe(false);
      expect(h.alarmScheduler.schedule).not.toHaveBeenCalled();
      expect(h.provider.takeSnapshot).not.toHaveBeenCalled();
      expect(h.wsManager.detachSandboxWebSocket).toHaveBeenCalledExactlyOnceWith(
        1000,
        "Boot budget exceeded"
      );
    }
  );

  it("names the boot itself when no phase was reported", async () => {
    const sandbox = createMockSandbox({
      status: "connecting",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs,
      boot_phase: null,
    });
    const h = createAlarmFixture(sandbox);

    await h.manager.handleAlarm();

    expect(h.broadcaster.messages).toContainEqual({
      type: "sandbox_error",
      error: expect.stringMatching(/^Sandbox boot exceeded 30 minutes while booting\./),
    });
  });

  it("does not apply to a ready sandbox, however old its reservation", async () => {
    const sandbox = createMockSandbox({
      status: "ready",
      created_at: Date.now() - DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs * 2,
    });
    const h = createAlarmFixture(sandbox);

    await expect(h.manager.handleAlarm()).resolves.toBe("no_action");

    expect(h.storage.fenceSandboxGeneration).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("ready");
  });
});
