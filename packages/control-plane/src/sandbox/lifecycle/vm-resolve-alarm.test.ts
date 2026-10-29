import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalApiError } from "../client";
import { formatPendingVmReference } from "../providers/pending-vm-reference";
import { PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS } from "./decisions";
import { createAlarmHandler } from "../../session/alarm/handler";
import type { SandboxLifecycleManager } from "./manager";
import { fixture } from "./vm-resolve.test-fixture";

/** The session's alarm handler, whose two preservation hooks each reach `handleShutdownAlarm`. */
function alarmHandler(manager: SandboxLifecycleManager, flushPending = async () => {}) {
  return createAlarmHandler({
    preserveBeforeWatchdogs: (allowCaptureRetry: boolean) =>
      manager.handleShutdownAlarm(allowCaptureRetry),
    terminalMessageProjection: { flushPending },
    executionStop: { recoverStopConfirmationTimeout: async () => {} },
    repository: {
      getProcessingMessageWithStartedAt: () => null,
      getNextPendingMessage: () => null,
    },
    // The heartbeat watchdog is not under test; these bridges send no heartbeats.
    lifecycleManager: { handleAlarm: async () => "no_action" },
  } as never);
}

describe("modal-vm alarm lookups for a connected bridge", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A restarted instance whose connected bridge's lookup window closed on retryable failures. */
  async function connectedBridgeAfterWindow() {
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    const restarted = f.makeManager();
    restarted.onSandboxSocketAttached(generation);
    expect(restarted.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    return { f, restarted, generation };
  }

  it("resumes a connected bridge's lookup once per alarm delivery after its retry window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, restarted, generation } = await connectedBridgeAfterWindow();
    // The failed lookup settles while the projection flush between the two hooks awaits I/O.
    const handler = alarmHandler(restarted, async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const attempts = f.client.resolveVmSandbox.mock.calls.length;
    const retryAt = Date.now() + 60_000;
    await handler.handle();
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(attempts + 1);
    expect(f.alarmScheduler.schedule).toHaveBeenCalledWith(retryAt);

    // An earlier alarm, such as an execution-timeout check, took the single alarm
    // slot; it restores the lookup's time instead of repeating the lookup.
    await vi.advanceTimersByTimeAsync(30_000);
    vi.mocked(f.alarmScheduler.schedule).mockClear();
    await handler.handle();
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(attempts + 1);
    expect(f.alarmScheduler.schedule).toHaveBeenCalledWith(retryAt);

    f.client.resolveVmSandbox.mockResolvedValue({
      sandboxId: generation.sandboxId,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
      codeServerUrl: "https://editor.example",
      codeServerPassword: "password",
    });
    await vi.advanceTimersByTimeAsync(retryAt - Date.now());
    await handler.handle();
    await vi.waitFor(() => expect(f.sandbox.modal_object_id).toBe("sb-real"));
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(attempts + 2);
    expect(f.sandbox.code_server_url).toBe("https://editor.example");
    expect(f.store.read()?.providerObjectId).toBe("sb-real");
  });

  /** A restore whose foreground and bridge lookups keep failing until both windows close. */
  async function heldVmRestore() {
    const f = fixture("restore");
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    const manager = f.makeManager();
    const restoring = manager.spawnSandbox();
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(60_000);
    const generation = { sandboxId: f.sandbox.modal_sandbox_id!, createdAt: f.sandbox.created_at };
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    // The socket's attach arms its disconnect check before adopting the bridge.
    await manager.scheduleDisconnectCheck();
    manager.onSandboxSocketAttached(generation);
    expect(manager.onRuntimeReady(Date.now(), undefined, 1)).toBe(true);
    manager.onShutdownGenerationReady({
      type: "sandbox_generation_ready",
      generation,
      sandboxId: generation.sandboxId,
      timestamp: Date.now(),
    });
    const resolved = {
      sandboxId: generation.sandboxId,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
    };
    return { f, manager, restoring, resolved };
  }

  it("keeps a held restore's lookup armed from its bridge's first alarm until it completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, manager, restoring, resolved } = await heldVmRestore();
    const handler = alarmHandler(manager);
    const windowsClosedAt = Date.now() + PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000;
    let next = f.alarmScheduler.alarms.at(-1)!;
    // The restore holds watchdogs, so only what each delivery arms can wake the session.
    const deliver = async () => {
      await vi.advanceTimersByTimeAsync(next - Date.now());
      const scheduled = f.alarmScheduler.alarms.length;
      await handler.handle();
      const armed = f.alarmScheduler.alarms.slice(scheduled).filter((at) => at > Date.now());
      expect(armed).not.toHaveLength(0);
      next = Math.min(...armed);
    };
    while (next < windowsClosedAt) await deliver();
    await restoring;
    expect(manager.pushAdmissionDecision()).toBe("held");
    f.client.resolveVmSandbox.mockResolvedValue(resolved);
    await deliver();
    await vi.waitFor(() => expect(manager.pushAdmissionDecision()).toBe("ready"));
    expect(f.sandbox.modal_object_id).toBe("sb-real");
    expect(f.store.read()).toMatchObject({ phase: "running", providerObjectId: "sb-real" });
  });

  it("fails the alarm delivery when a held restore's next lookup cannot be armed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, manager, restoring, resolved } = await heldVmRestore();
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    await restoring;
    const handler = alarmHandler(manager);
    const attempts = f.client.resolveVmSandbox.mock.calls.length;
    const unavailable = new Error("alarm storage unavailable");
    vi.mocked(f.alarmScheduler.schedule).mockRejectedValueOnce(unavailable);
    // Failing the delivery is what makes the platform retry it.
    await expect(handler.handle()).rejects.toBe(unavailable);
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(attempts);
    f.client.resolveVmSandbox.mockResolvedValue(resolved);
    await handler.handle();
    await vi.waitFor(() => expect(manager.pushAdmissionDecision()).toBe("ready"));
    expect(f.store.read()).toMatchObject({ phase: "running", providerObjectId: "sb-real" });
  });

  it.each([
    ["a non-retryable error", new ModalApiError("forbidden", 403)],
    ["not_visible past the materialization bound", new ModalApiError("gone", 409, "not_visible")],
  ])("ends a generation's alarm lookups after %s", async (_answer, terminal) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, restarted } = await connectedBridgeAfterWindow();
    const handler = alarmHandler(restarted);
    const drainAtMs = f.store.read()!.drainAtMs;
    f.client.resolveVmSandbox.mockRejectedValue(terminal);
    const lookups = f.client.resolveVmSandbox.mock.calls.length + 1;
    await handler.handle();
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(lookups);
    for (let delivery = 0; delivery < 3; delivery++) {
      await vi.advanceTimersByTimeAsync(60_000);
      const armed = f.alarmScheduler.alarms.length;
      await handler.handle();
      // Only the shutdown's own drain deadline is reasserted.
      expect(f.alarmScheduler.alarms.slice(armed).filter((at) => at !== drainAtMs)).toEqual([]);
    }
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(lookups);
  });

  it("arms no alarm lookup for a pending bridge whose socket is gone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, restarted } = await connectedBridgeAfterWindow();
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue(null);
    const drainAtMs = f.store.read()!.drainAtMs;
    const lookups = f.client.resolveVmSandbox.mock.calls.length;
    const armed = f.alarmScheduler.alarms.length;
    await alarmHandler(restarted).handle();
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(lookups);
    expect(f.alarmScheduler.alarms.slice(armed).filter((at) => at !== drainAtMs)).toEqual([]);
  });

  it("arms no alarm lookup while a checkpoint in flight holds the sandbox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, restarted } = await connectedBridgeAfterWindow();
    f.store.write({ ...f.store.read()!, checkpointInFlight: true });
    const lookups = f.client.resolveVmSandbox.mock.calls.length;
    vi.mocked(f.alarmScheduler.schedule).mockClear();
    await alarmHandler(restarted).handle();
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(lookups);
    expect(f.alarmScheduler.schedule).not.toHaveBeenCalled();
  });

  it("arms no alarm lookup for a restore whose in-memory ownership a restart dropped", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const { f, restoring } = await heldVmRestore();
    await vi.advanceTimersByTimeAsync(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS + 20_000);
    await restoring;
    const restarted = f.makeManager();
    const lookups = f.client.resolveVmSandbox.mock.calls.length;
    vi.mocked(f.alarmScheduler.schedule).mockClear();
    await alarmHandler(restarted).handle();
    // The restore's outcome is unknown to the new instance, so it stays held for explicit recovery.
    expect(f.store.read()?.phase).toBe("unknown");
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(lookups);
    expect(f.alarmScheduler.schedule).not.toHaveBeenCalled();
  });

  it.each(["fenced", "stopped", "resolved", "another session's"] as const)(
    "arms no alarm lookup when the generation is %s",
    async (change) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
      const { f, restarted } = await connectedBridgeAfterWindow();
      if (change === "fenced") f.sandbox.fenced = 1;
      if (change === "stopped") f.sandbox.status = "stopped";
      if (change === "resolved") f.sandbox.modal_object_id = "sb-real";
      if (change === "another session's")
        f.sandbox.modal_object_id = formatPendingVmReference(
          "another-session",
          f.sandbox.modal_sandbox_id!
        );
      const drainAtMs = f.store.read()!.drainAtMs;
      const lookups = f.client.resolveVmSandbox.mock.calls.length;
      const armed = f.alarmScheduler.alarms.length;
      await alarmHandler(restarted).handle();
      expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(lookups);
      expect(f.alarmScheduler.alarms.slice(armed).filter((at) => at !== drainAtMs)).toEqual([]);
    }
  );

  it("keeps an alarm's single attempt when it waits behind another generation's lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const restarted = f.makeManager();
    let rejectOlder!: (error: Error) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectOlder = reject))
    );
    restarted.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    const newer = { sandboxId: "newer-generation", createdAt: f.sandbox.created_at + 1 };
    f.sandbox.modal_sandbox_id = newer.sandboxId;
    f.sandbox.created_at = newer.createdAt;
    f.sandbox.modal_object_id = formatPendingVmReference("test-session", newer.sandboxId);
    f.sandbox.status = "ready";
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    await restarted.handleShutdownAlarm();
    rejectOlder(new ModalApiError("unavailable", 503));
    // Short of the next alarm lookup: only the queued attempt may have run.
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.client.resolveVmSandbox).toHaveBeenCalledTimes(2);
    expect(f.client.resolveVmSandbox.mock.calls[1][0]).toMatchObject({
      sandboxId: newer.sandboxId,
    });
  });

  it("keeps a queued attach's retry window when an alarm attempt joins it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const f = fixture();
    f.client.createSandbox.mockImplementationOnce(() => new Promise(() => {}));
    void f.makeManager().spawnSandbox();
    await vi.waitFor(() => expect(f.client.createSandbox).toHaveBeenCalledOnce());
    const restarted = f.makeManager();
    let rejectOlder!: (error: Error) => void;
    f.client.resolveVmSandbox.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (rejectOlder = reject))
    );
    restarted.onSandboxSocketAttached({
      sandboxId: f.sandbox.modal_sandbox_id!,
      createdAt: f.sandbox.created_at,
    });
    await vi.waitFor(() => expect(f.client.resolveVmSandbox).toHaveBeenCalledOnce());
    const newer = { sandboxId: "newer-generation", createdAt: f.sandbox.created_at + 1 };
    f.sandbox.modal_sandbox_id = newer.sandboxId;
    f.sandbox.created_at = newer.createdAt;
    f.sandbox.modal_object_id = formatPendingVmReference("test-session", newer.sandboxId);
    f.sandbox.status = "connecting";
    vi.mocked(f.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
    f.client.resolveVmSandbox.mockRejectedValue(new ModalApiError("unavailable", 503));
    restarted.onSandboxSocketAttached(newer);
    await restarted.handleShutdownAlarm();
    rejectOlder(new ModalApiError("unavailable", 503));
    f.client.resolveVmSandbox.mockRejectedValueOnce(new ModalApiError("unavailable", 503));
    f.client.resolveVmSandbox.mockResolvedValue({
      sandboxId: newer.sandboxId,
      modalObjectId: "sb-real",
      sandboxBackend: "modal-vm",
    });
    // The attach's window retries 10 s later, before any alarm lookup is due.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.sandbox.modal_object_id).toBe("sb-real");
  });
});
