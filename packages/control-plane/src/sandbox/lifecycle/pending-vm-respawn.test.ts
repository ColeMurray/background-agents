import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalApiError } from "../client";
import type { ModalClient } from "../client";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { ModalSandboxProvider } from "../providers/modal-provider";
import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "../provider";
import {
  formatPendingVmReference,
  parsePendingVmReference,
} from "../providers/pending-vm-reference";
import { DEFAULT_LIFECYCLE_CONFIG, SandboxLifecycleManager } from "./manager";
import { SandboxShutdownCoordinator } from "../../session/sandbox-shutdown";
import type { ShutdownRecord } from "../../session/sandbox-shutdown-repository";
import {
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  PENDING_VM_REFERENCE_LAUNCH_WINDOW_MS,
  PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS,
} from "./decisions";
import {
  createAlarmFixture,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createTestConfig,
} from "./test-helpers";

describe("pending VM reference recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("fits inside the connect watchdog", () => {
    expect(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS).toBeGreaterThan(
      PENDING_VM_REFERENCE_LAUNCH_WINDOW_MS + 150_000
    );
    expect(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS).toBeLessThan(
      DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs
    );
  });

  it.each([
    ["create", undefined, 0],
    ["create", 5_400, 0],
    ["restore", 5_400, 0],
    ["create", 601, 2_000],
  ] as const)(
    "tracks a %s's pending handle with %s-second timeout after %s ms setup",
    async (action, timeoutSeconds, setupDelayMs) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const sandbox = createMockSandbox({
        status: action === "create" ? "pending" : "stopped",
        modal_object_id: "sb-prior",
        snapshot_image_id: action === "restore" ? "im-saved" : null,
        snapshot_runtime_version: action === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
      });
      const storage = createMockStorage(
        createMockSession({
          sandbox_settings: timeoutSeconds
            ? JSON.stringify({
                sandboxTimeoutMs: timeoutSeconds * 1000,
                finalSnapshotBufferMs: 600_000,
              })
            : null,
        }),
        sandbox
      );
      if (setupDelayMs) {
        vi.mocked(storage.getUserEnvVars).mockImplementationOnce(async () => {
          vi.setSystemTime(Date.now() + setupDelayMs);
          return undefined;
        });
      }
      const loseResponse = vi.fn(async () => {
        sandbox.status = "ready";
        throw new Error("response lost after bridge attached");
      });
      const client = {
        createSandbox: vi.fn(loseResponse),
        restoreSandbox: vi.fn(loseResponse),
        stopSandbox: vi.fn(async () => {}),
      };
      const provider = new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm");
      let state: ShutdownRecord | null = null;
      const deps = {
        store: {
          read: () => (state ? structuredClone(state) : null),
          write: (next: ShutdownRecord) => {
            state = structuredClone(next);
          },
        },
        provider,
        sandbox: storage,
        session: { getSession: () => storage.getSession(), transaction: <T>(fn: () => T) => fn() },
        messages: { getProcessingMessage: () => null },
        failures: { record: vi.fn(), deliver: vi.fn() },
        messenger: createMockBroadcaster(),
        sockets: { getSandboxSocket: () => null },
        alarm: createMockAlarmScheduler(),
        background: { submit: vi.fn() },
        onLifecycleChange: vi.fn(async () => {}),
        reconcileStatusFromMessages: vi.fn(async () => {}),
        retireAccess: vi.fn(),
      };
      const shutdown = new SandboxShutdownCoordinator(deps as never);
      const manager = new SandboxLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        shutdown,
        createTestConfig()
      );

      await manager.spawnSandbox();

      const generation = { sandboxId: sandbox.modal_sandbox_id!, createdAt: sandbox.created_at };
      const reference = formatPendingVmReference("test-session", generation.sandboxId);
      const launch = action === "create" ? client.createSandbox : client.restoreSandbox;
      const restarted = new SandboxShutdownCoordinator(deps as never);
      if (setupDelayMs) {
        expect(Date.now() - generation.createdAt).toBeLessThan(
          PENDING_VM_REFERENCE_LAUNCH_WINDOW_MS
        );
        expect(launch).not.toHaveBeenCalled();
        expect(sandbox.status).toBe("failed");
        expect(restarted.snapshot()?.phase).toBe("running");
        return;
      }
      expect(launch).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutSeconds: timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS,
        }),
        undefined
      );
      expect(sandbox.modal_object_id).toBe(reference);
      expect(state).toMatchObject({
        generation,
        providerObjectId: reference,
        lifetimeKind: "finite",
        lifetimeSource: "conservative_start_bound",
        expiresAtMs:
          generation.createdAt + (timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS) * 1000,
      });
      expect(restarted.admissionDecision()).toBe("held"); // Still waits for generation-ready.
    }
  );

  it("respawns after a lost create response and boot-budget stop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const vm = { running: false, generation: null as string | null };
    const client = {
      createSandbox: vi.fn(async (req: { sandboxId: string }) => {
        vm.running = true;
        vm.generation = req.sandboxId;
        if (client.createSandbox.mock.calls.length === 1) {
          sandbox.status = "connecting";
          sandbox.last_heartbeat = Date.now();
          vi.mocked(fixture.wsManager.getSandboxWebSocket).mockReturnValue({} as WebSocket);
          throw new Error("response lost");
        }
        return { sandboxId: req.sandboxId, modalObjectId: "sb-new", sandboxBackend: "modal-vm" };
      }),
      stopSandbox: vi.fn(async ({ providerObjectId }: { providerObjectId: string }) => {
        if (providerObjectId.startsWith("modal-vm-session:")) {
          const generation = parsePendingVmReference(providerObjectId)?.sandboxId;
          if (!vm.running || vm.generation !== generation)
            throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
        }
        vm.running = false;
      }),
    };
    const fixture = createAlarmFixture(
      sandbox,
      new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm")
    );
    await fixture.manager.spawnSandbox();
    vi.setSystemTime(Date.now() + DEFAULT_LIFECYCLE_CONFIG.bootBudget.timeoutMs + 1);
    sandbox.last_heartbeat = Date.now();
    expect(await fixture.manager.handleAlarm()).toMatchObject({ kind: "boot_budget_exceeded" });
    expect(sandbox.fenced).toBe(1);
    await fixture.manager.spawnSandbox();
    expect(client.createSandbox).toHaveBeenCalledTimes(2);
    expect(sandbox.fenced).toBe(0);
  });

  it("respawns after a restart and a failed connect-watchdog stop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const client = {
      createSandbox: vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockImplementation(async (req: { sandboxId: string }) => ({
          sandboxId: req.sandboxId,
          modalObjectId: "sb-new",
          sandboxBackend: "modal-vm",
        })),
      stopSandbox: vi.fn(async () => {
        throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
      }),
    };
    const provider = new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm");
    const first = createAlarmFixture(sandbox, provider);
    void first.manager.spawnSandbox();
    await vi.waitFor(() => expect(client.createSandbox).toHaveBeenCalledOnce());
    const restarted = createAlarmFixture(sandbox, provider);
    vi.setSystemTime(Date.now() + DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs + 1);
    expect(await restarted.manager.handleAlarm()).toBe("sandbox_failed");
    expect(sandbox.fenced).toBe(1);
    await restarted.manager.spawnSandbox();
    expect(client.createSandbox).toHaveBeenCalledTimes(2);
    expect(sandbox.fenced).toBe(0);
  });

  it("does not dispatch a VM launch after configuration delays past the launch window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const sandbox = createMockSandbox({ status: "pending", modal_object_id: null });
    const createSandbox = vi.fn();
    const fixture = createAlarmFixture(
      sandbox,
      new ModalSandboxProvider({ createSandbox } as unknown as ModalClient, "modal-vm")
    );
    let finishLookup!: (value: undefined) => void;
    vi.mocked(fixture.storage.getUserEnvVars).mockImplementationOnce(
      () => new Promise((resolve) => (finishLookup = resolve))
    );
    const spawning = fixture.manager.spawnSandbox();
    await vi.waitFor(() => expect(fixture.storage.getUserEnvVars).toHaveBeenCalledOnce());
    vi.setSystemTime(Date.now() + 120_000);
    finishLookup(undefined);
    await spawning;
    expect(createSandbox).not.toHaveBeenCalled();
    expect(sandbox.status).toBe("failed");
  });

  it("refuses an invisible young fenced generation and reports the failed preflight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const createSandbox = vi.fn();
    const provider = new ModalSandboxProvider(
      {
        createSandbox,
        stopSandbox: vi.fn(async () => {
          throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
        }),
      } as unknown as ModalClient,
      "modal-vm"
    );
    const sandbox = createMockSandbox({
      status: "failed",
      fenced: 1,
      created_at: Date.now(),
      modal_object_id: formatPendingVmReference("test-session", "old-generation"),
    });
    const fixture = createAlarmFixture(sandbox, provider);
    await fixture.manager.spawnSandbox();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(sandbox.modal_sandbox_id).toBe("sandbox-testowner-testrepo-123");
    expect(sandbox.last_spawn_error).toMatch(/stop|visible/i);
    expect(fixture.broadcaster.messages).toContainEqual({
      type: "sandbox_error",
      error: sandbox.last_spawn_error,
    });
  });

  it("respawns a previously written two-part fenced reference after the bound", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const createSandbox = vi.fn(async (req: { sandboxId: string }) => ({
      sandboxId: req.sandboxId,
      modalObjectId: "sb-new",
      sandboxBackend: "modal-vm",
    }));
    const provider = new ModalSandboxProvider(
      {
        createSandbox,
        stopSandbox: vi.fn(async () => {
          throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
        }),
      } as unknown as ModalClient,
      "modal-vm"
    );
    const sandbox = createMockSandbox({
      status: "failed",
      fenced: 1,
      modal_sandbox_id: "old-generation",
      created_at: Date.now() - PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS,
      modal_object_id: 'modal-vm-session:["test-session","old-generation"]',
    });
    const fixture = createAlarmFixture(sandbox, provider);
    await fixture.manager.spawnSandbox();
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(sandbox.fenced).toBe(0);
    expect(sandbox.modal_object_id).toBe("sb-new");
  });

  it("restores after confirming an old fenced pending reference is absent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stopSandbox = vi.fn(async () => {
      throw new ModalApiError("not visible", 409, "pending_reference_not_visible");
    });
    const restoreSandbox = vi.fn(async (req: { sandboxId: string }) => ({
      sandboxId: req.sandboxId,
      modalObjectId: "sb-restored",
      sandboxBackend: "modal-vm",
    }));
    const provider = new ModalSandboxProvider(
      { stopSandbox, restoreSandbox } as unknown as ModalClient,
      "modal-vm"
    );
    const sandbox = createMockSandbox({
      status: "stopped",
      fenced: 1,
      created_at: Date.now() - PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS,
      modal_object_id: formatPendingVmReference("test-session", "old-generation"),
      snapshot_image_id: "im-saved",
      snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
    });
    const fixture = createAlarmFixture(sandbox, provider);
    await fixture.manager.spawnSandbox();
    expect(restoreSandbox).toHaveBeenCalledOnce();
    expect(sandbox.fenced).toBe(0);
    expect(sandbox.modal_object_id).toBe("sb-restored");
  });
});
