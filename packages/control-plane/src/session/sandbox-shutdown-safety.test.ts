import { describe, expect, it, vi } from "vitest";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { SandboxProvider } from "../sandbox/provider";
import { SandboxShutdownCoordinator } from "./sandbox-shutdown";
import type { ShutdownRecord, ShutdownStore } from "./sandbox-shutdown-repository";

const GENERATION = { sandboxId: "sandbox-current", createdAt: 1_000 };

type TestRecord = ShutdownRecord;

class MemoryStore implements ShutdownStore {
  constructor(public value: TestRecord | null) {}

  read(): TestRecord | null {
    return this.value;
  }

  write(record: ShutdownRecord): void {
    this.value = structuredClone(record);
  }
}

function runningRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return {
    phase: "running",
    generation: GENERATION,
    provider: "modal",
    providerObjectId: "provider-current",
    sourceRetired: false,
    lifetimeKind: "finite",
    expiresAtMs: 2_000_000,
    drainAtMs: 1_000_000,
    generationReady: true,
    runtimeReady: true,
    protocolVersion: 1,
    lifecyclePolicy: "confirmed",
    ...overrides,
  };
}

function recoveryRecord(overrides: Partial<TestRecord> = {}): TestRecord {
  return runningRecord({
    phase: "unknown",
    error: "Prior shutdown outcome requires recovery",
    expiresAtMs: 90_000,
    drainAtMs: 80_000,
    receipt: {
      kind: "snapshot",
      artifactId: "saved-snapshot",
      provider: "modal",
      savedAtMs: 75_000,
      runtimeVersion: "v72-runtime",
    },
    ...overrides,
  });
}

function fixture(
  initial: TestRecord,
  options: {
    now?: number;
    stopResult?: { success: boolean; error?: string };
    takeSnapshot?: SandboxProvider["takeSnapshot"];
  } = {}
) {
  const store = new MemoryStore(initial);
  const stopSandbox = vi.fn(async () => options.stopResult ?? { success: true });
  const provider: SandboxProvider = {
    name: "modal",
    capabilities: {
      supportsSandboxTimeout: true,
      supportsSnapshots: true,
      supportsRestore: true,
      supportsPersistentResume: false,
      supportsExplicitStop: true,
    },
    createSandbox: async () => {
      throw new Error("not used by shutdown safety tests");
    },
    stopSandbox,
    takeSnapshot: options.takeSnapshot,
  };
  const sandboxRow = {
    modal_sandbox_id: GENERATION.sandboxId,
    modal_object_id: "provider-current",
    created_at: GENERATION.createdAt,
    runtime_version: "v72-runtime",
    status: "ready",
  };
  const shutdown = new SandboxShutdownCoordinator({
    store,
    provider,
    sandbox: {
      getSandbox: () => sandboxRow,
      updateSandboxStatus: vi.fn((status: SandboxStatus) => {
        sandboxRow.status = status;
      }),
      transitionSandboxStatus: vi.fn(
        (generation: typeof GENERATION, from: SandboxStatus, to: SandboxStatus) => {
          if (
            generation.sandboxId !== sandboxRow.modal_sandbox_id ||
            generation.createdAt !== sandboxRow.created_at ||
            sandboxRow.status !== from
          )
            return false;
          sandboxRow.status = to;
          return true;
        }
      ),
      recordSandboxSnapshot: vi.fn(() => true),
    },
    session: {
      getSession: () => ({ id: "session-1", session_name: "shutdown-safety" }),
    },
    messages: { getProcessingMessage: () => null },
    failures: { record: vi.fn(), deliver: vi.fn() },
    messenger: { broadcast: vi.fn() },
    sockets: { getSandboxSocket: () => null, send: vi.fn() },
    alarm: { schedule: vi.fn(async () => undefined) },
    background: { submit: vi.fn() },
    onLifecycleChange: vi.fn(async () => undefined),
    reconcileStatusFromMessages: vi.fn(async () => undefined),
    retireAccess: vi.fn(),
    now: () => options.now ?? 100_000,
  } as never);
  return { shutdown, provider, sandboxRow, stopSandbox, store };
}

describe("sandbox shutdown safety", () => {
  it("holds destructive watchdogs while an ordinary checkpoint is in flight", async () => {
    let resolveSnapshot!: (result: {
      success: true;
      imageId: string;
      sourceStopped: false;
    }) => void;
    const takeSnapshot = vi.fn(
      () =>
        new Promise<{ success: true; imageId: string; sourceStopped: false }>((resolve) => {
          resolveSnapshot = resolve;
        })
    );
    const h = fixture(runningRecord(), { takeSnapshot });

    const capture = h.shutdown.captureCheckpoint(GENERATION, "execution_complete");
    await vi.waitFor(() => expect(takeSnapshot).toHaveBeenCalledOnce());

    await expect(h.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");
    await expect(h.shutdown.captureCheckpoint(GENERATION, "inactivity_timeout")).resolves.toEqual({
      outcome: "held",
    });
    expect(takeSnapshot).toHaveBeenCalledOnce();
    expect(h.stopSandbox).not.toHaveBeenCalled();

    resolveSnapshot({ success: true, imageId: "checkpoint-image", sourceStopped: false });
    await expect(capture).resolves.toEqual({
      outcome: "saved",
      imageId: "checkpoint-image",
      sourceStopped: false,
    });
  });

  it.each([
    [
      "a thrown transport error",
      async () => {
        throw new Error("provider transport response lost");
      },
    ],
    ["an unsuccessful provider result", async () => ({ success: false, error: "transport lost" })],
    ["a successful result without an image ID", async () => ({ success: true })],
  ] satisfies Array<[string, NonNullable<SandboxProvider["takeSnapshot"]>]>)(
    "holds admission when an ordinary checkpoint gets %s",
    async (_label, providerCapture) => {
      const takeSnapshot = vi.fn(providerCapture);
      const h = fixture(runningRecord(), { takeSnapshot });

      await expect(h.shutdown.captureCheckpoint(GENERATION, "execution_complete")).resolves.toEqual(
        { outcome: "unknown" }
      );

      expect(h.store.value).toMatchObject({
        phase: "unknown",
        checkpointInFlight: false,
        error: expect.stringMatching(/checkpoint/i),
      });
      expect(h.shutdown.admissionDecision()).toBe("held");
      await expect(h.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");
      expect(h.stopSandbox).not.toHaveBeenCalled();
      await expect(h.shutdown.recover("retry")).rejects.toThrow("cannot be retried safely");
      await expect(h.shutdown.captureCheckpoint(GENERATION, "execution_complete")).resolves.toEqual(
        { outcome: "held" }
      );
      expect(takeSnapshot).toHaveBeenCalledOnce();
      expect(h.shutdown.admissionDecision()).toBe("held");
    }
  );

  it("projects legacy interrupted saved state as paused until explicit resume", async () => {
    const h = fixture(
      recoveryRecord({
        phase: "saved",
        sourceRetired: true,
        messageId: "interrupted-before-continuation-flag",
        continuationPaused: undefined,
      })
    );

    expect(h.shutdown.snapshot()).toMatchObject({
      phase: "saved",
      continuationPaused: true,
    });
    expect(h.shutdown.admissionDecision()).toBe("held");
    expect(h.shutdown.startupDecision()).toMatchObject({ kind: "hold" });

    await h.shutdown.recover("restore_saved");

    expect(h.store.value).toMatchObject({
      phase: "saved",
      continuationPaused: false,
      messageId: "interrupted-before-continuation-flag",
    });
    expect(h.shutdown.snapshot()).toMatchObject({ continuationPaused: false });
    expect(h.shutdown.admissionDecision()).toBe("restore_required");
  });

  it.each([
    ["conservative expiry", "conservative_start_bound" as const],
    ["legacy expiry without provenance", undefined],
  ])(
    "verifies provider stop for %s before restoring saved state",
    async (_label, lifetimeSource) => {
      const h = fixture(recoveryRecord({ lifetimeSource }), {
        now: 100_000,
        stopResult: { success: false, error: "provider stop not confirmed" },
      });

      await h.shutdown.recover("restore_saved");

      expect(h.stopSandbox).toHaveBeenCalledOnce();
      expect(h.store.value).toMatchObject({
        phase: "unknown",
        sourceRetired: false,
        receipt: { artifactId: "saved-snapshot" },
      });
      expect(h.shutdown.admissionDecision()).toBe("held");
    }
  );

  it("accepts authoritative provider expiry as retirement proof", async () => {
    const h = fixture(recoveryRecord({ lifetimeSource: "provider" }), { now: 100_000 });

    await h.shutdown.recover("restore_saved");

    expect(h.stopSandbox).not.toHaveBeenCalled();
    expect(h.store.value).toMatchObject({
      phase: "saved",
      sourceRetired: true,
      receipt: { artifactId: "saved-snapshot" },
    });
  });
});
