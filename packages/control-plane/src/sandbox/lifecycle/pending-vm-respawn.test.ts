import { afterEach, describe, expect, it, vi } from "vitest";
import { ModalApiError } from "../client";
import type { ModalClient } from "../client";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { ModalSandboxProvider } from "../providers/modal-provider";
import { DEFAULT_LIFECYCLE_CONFIG } from "./manager";
import {
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS,
} from "./decisions";
import { createAlarmFixture, createMockSandbox } from "./test-helpers";

describe("pending VM reference recovery", () => {
  afterEach(() => vi.useRealTimers());

  it("fits inside the connect watchdog", () => {
    expect(PENDING_VM_REFERENCE_MATERIALIZE_BOUND_MS).toBeLessThan(
      DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs
    );
  });

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
          const [, generation] = JSON.parse(providerObjectId.slice("modal-vm-session:".length));
          if (!vm.running || vm.generation !== generation)
            throw new ModalApiError("pending_reference_not_visible", 409);
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
        throw new ModalApiError("pending_reference_not_visible", 409);
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

  it("refuses an invisible young fenced generation and reports the failed preflight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const createSandbox = vi.fn();
    const provider = new ModalSandboxProvider(
      {
        createSandbox,
        stopSandbox: vi.fn(async () => {
          throw new ModalApiError("pending_reference_not_visible", 409);
        }),
      } as unknown as ModalClient,
      "modal-vm"
    );
    const sandbox = createMockSandbox({
      status: "failed",
      fenced: 1,
      created_at: Date.now(),
      modal_object_id: provider.pendingSandboxReference("test-session", "old-generation"),
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

  it("restores after confirming an old fenced pending reference is absent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const stopSandbox = vi.fn(async () => {
      throw new ModalApiError("pending_reference_not_visible", 409);
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
      modal_object_id: provider.pendingSandboxReference("test-session", "old-generation"),
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
