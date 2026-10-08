import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxProvider } from "../sandbox/provider";
import { SandboxShutdownCoordinator } from "./sandbox-shutdown";
import {
  SandboxShutdownRepository,
  type ShutdownRecord,
  type ShutdownStore,
} from "./sandbox-shutdown-repository";
import { createAlarmHandler } from "./alarm/handler";
import { createEarliestAlarmScheduler, handleAlarmDelivery } from "./alarm/scheduler";

const GENERATION = { sandboxId: "sandbox-1", createdAt: 1_000 };
const PENDING_VM_REFERENCE = 'modal-vm-session:["session-1","sandbox-1"]';

class MemoryStore implements ShutdownStore {
  value: ShutdownRecord | null = null;
  read() {
    return this.value;
  }
  write(record: ShutdownRecord) {
    this.value = structuredClone(record);
  }
}

/** The real repository over one row, so records pass its schema as in production. */
class DurableStore implements ShutdownStore {
  private row: string | null = null;
  private readonly repository = new SandboxShutdownRepository({
    exec: (query: string, ...params: unknown[]) => {
      if (query.trimStart().startsWith("INSERT")) this.row = params[0] as string;
      const rows =
        query.trimStart().startsWith("SELECT") && this.row !== null ? [{ state: this.row }] : [];
      return { toArray: () => rows, one: () => rows[0] ?? null };
    },
  });
  get value() {
    return this.repository.read();
  }
  read() {
    return this.repository.read();
  }
  write(record: ShutdownRecord) {
    this.repository.write(record);
  }
}

function provider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    name: "modal",
    capabilities: {
      supportsSandboxTimeout: true,
      supportsSnapshots: true,
      supportsRestore: true,
      supportsPersistentResume: false,
      supportsExplicitStop: true,
    },
    ...overrides,
  } as SandboxProvider;
}

function fixture(providerValue = provider(), options: { durable?: boolean } = {}) {
  let now = 100_000;
  const store = options.durable ? new DurableStore() : new MemoryStore();
  const calls: string[] = [];
  const backgroundTasks: Array<() => Promise<void>> = [];
  const socket = {};
  const sandboxRow = {
    modal_sandbox_id: GENERATION.sandboxId,
    modal_object_id: "provider-object-1" as string | null,
    created_at: GENERATION.createdAt,
    runtime_version: "runtime-1",
    status: "ready",
    last_heartbeat: 100_000 as number | null,
  };
  const deps = {
    store,
    provider: providerValue,
    sandbox: {
      getSandbox: vi.fn(() => sandboxRow),
      recordSandboxSnapshot: vi.fn(() => calls.push("snapshot-recorded")),
      updateSandboxStatus: vi.fn(() => calls.push("sandbox-stopped")),
      transitionSandboxStatus: vi.fn((_generation, from, to) => {
        if (sandboxRow.status !== from) return false;
        sandboxRow.status = to;
        return true;
      }),
      discardSandboxState: vi.fn(() => {
        sandboxRow.status = "stopped";
        sandboxRow.modal_object_id = null;
        return true;
      }),
      updateSandboxLastActivity: vi.fn(),
    },
    session: {
      getSession: vi.fn(() => ({
        id: "session-1",
        session_name: "external-session-1",
        sandbox_settings: JSON.stringify({ finalSnapshotBufferMs: 600_000 }),
      })),
      transaction: vi.fn((fn: () => unknown) => fn()),
    },
    messages: {
      getProcessingMessage: vi.fn<() => { id: string } | null>(() => null),
    },
    failures: { record: vi.fn(), deliver: vi.fn() },
    events: { createEventIfAbsent: vi.fn(() => true) },
    messenger: {
      broadcast: vi.fn((message: { type: string; preservation?: { phase: string } }) => {
        if (message.type === "sandbox_preservation" && message.preservation) {
          calls.push(`phase:${message.preservation.phase}`);
        }
      }),
    },
    sockets: {
      getSandboxSocket: vi.fn(() => socket),
      send: vi.fn(),
    },
    alarm: { schedule: vi.fn(async (_atMs: number) => undefined) },
    background: {
      submit: vi.fn((task: () => Promise<void>) => backgroundTasks.push(task)),
    },
    onLifecycleChange: vi.fn(async () => undefined),
    reconcileStatusFromMessages: vi.fn(async () => undefined),
    retireAccess: vi.fn(() => calls.push("access-retired")),
    now: () => now,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const shutdown = new SandboxShutdownCoordinator(deps as never);
  return {
    shutdown,
    deps,
    store,
    calls,
    backgroundTasks,
    sandboxRow,
    setNow(value: number) {
      now = value;
    },
  };
}

async function readyFinite(f: ReturnType<typeof fixture>, expiresAtMs = 1_300_000) {
  reserveGeneration(f, GENERATION, "confirmed");
  await f.shutdown.recordProviderStartup(GENERATION, {
    kind: "finite",
    expiresAtMs,
    observedAtMs: 100_000,
    source: "provider",
  });
  f.shutdown.runtimeReady(1);
  f.shutdown.generationReady({
    type: "sandbox_generation_ready",
    generation: GENERATION,
    sandboxId: GENERATION.sandboxId,
    timestamp: 1,
  });
}

async function readyWithoutDeadline(f: ReturnType<typeof fixture>) {
  reserveGeneration(f, GENERATION, "confirmed");
  await f.shutdown.recordProviderStartup(GENERATION, { kind: "none", observedAtMs: 100_000 });
  f.shutdown.runtimeReady(1);
  f.shutdown.generationReady({
    type: "sandbox_generation_ready",
    generation: GENERATION,
    sandboxId: GENERATION.sandboxId,
    timestamp: 1,
  });
}

function reserveGeneration(
  f: ReturnType<typeof fixture>,
  generation: typeof GENERATION,
  policy: "confirmed" | "legacy"
) {
  f.shutdown.reserveStartup(generation.createdAt, policy, () => {
    f.sandboxRow.modal_sandbox_id = generation.sandboxId;
    f.sandboxRow.created_at = generation.createdAt;
  });
}

/** Every recovery action the public projection offers, including discard. */
function recoveryActions(shutdown: SandboxShutdownCoordinator): string[] {
  const state = shutdown.snapshot();
  return [
    ...(state?.availableRecoveryActions ?? []),
    ...(state?.discardAvailable ? ["discard"] : []),
  ];
}

function preparedEvent(
  state: ShutdownRecord
): Extract<SandboxEvent, { type: "preservation_prepared" }> {
  return {
    type: "preservation_prepared",
    operationId: state.operationId!,
    generation: GENERATION,
    executionStopped: true,
    sandboxId: GENERATION.sandboxId,
    timestamp: 1,
  };
}

describe("SandboxShutdownCoordinator", () => {
  beforeEach(() => vi.restoreAllMocks());

  function pendingVmFixture(overrides: Partial<SandboxProvider> = {}) {
    const takeSnapshot = vi.fn(async () => ({
      success: true as const,
      imageId: "im-1",
      sourceStopped: false,
      sourceObjectId: "sb-real",
    }));
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(
      provider({
        name: "modal-vm",
        capabilities: { ...provider().capabilities, snapshotRequiresShutdown: true },
        takeSnapshot,
        stopSandbox,
        ...overrides,
      })
    );
    reserveGeneration(f, GENERATION, "confirmed");
    f.sandboxRow.modal_object_id = PENDING_VM_REFERENCE;
    return { ...f, takeSnapshot, stopSandbox };
  }

  async function pendingVmReady(f: ReturnType<typeof pendingVmFixture>) {
    await f.shutdown.recordPendingProviderHandle(GENERATION, PENDING_VM_REFERENCE, {
      kind: "finite",
      expiresAtMs: GENERATION.createdAt + 1_200_000,
      observedAtMs: GENERATION.createdAt,
      source: "conservative_start_bound",
    });
    f.shutdown.runtimeReady(1);
    f.shutdown.generationReady({
      type: "sandbox_generation_ready",
      generation: GENERATION,
      sandboxId: GENERATION.sandboxId,
      timestamp: 1,
    });
  }

  it("admits a ready VM after its create response is lost", async () => {
    const f = pendingVmFixture();
    await pendingVmReady(f);

    expect(f.store.value).toMatchObject({
      providerObjectId: PENDING_VM_REFERENCE,
      lifetimeKind: "finite",
      lifetimeSource: "conservative_start_bound",
      expiresAtMs: 1_201_000,
      drainAtMs: 601_000,
    });
    expect(f.deps.alarm.schedule).toHaveBeenCalledWith(601_000);
    expect(f.shutdown.admissionDecision()).toBe("ready");
  });

  it("saves a VM through its pending handle and retires the resolved source", async () => {
    const f = pendingVmFixture();
    await pendingVmReady(f);

    await f.shutdown.requestShutdown("inactivity_timeout");
    f.shutdown.prepared(preparedEvent(f.store.value!));
    await f.shutdown.handleAlarm();

    expect(f.takeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: PENDING_VM_REFERENCE })
    );
    expect(f.store.value).toMatchObject({
      phase: "saved",
      sourceRetired: true,
      receipt: { artifactId: "im-1", sourceObjectId: "sb-real" },
    });
    expect(f.stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "sb-real" })
    );
  });

  it("stops the pending VM before discarding a failed capture", async () => {
    const f = pendingVmFixture({
      takeSnapshot: vi.fn(async () => ({ success: false as const, error: "capture failed" })),
    });
    await pendingVmReady(f);

    await f.shutdown.requestShutdown("inactivity_timeout");
    f.shutdown.prepared(preparedEvent(f.store.value!));
    await f.shutdown.handleAlarm();
    expect(f.store.value?.phase).toBe("unknown");
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "discard"]);

    await f.shutdown.recover("discard");
    expect(f.stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: PENDING_VM_REFERENCE })
    );
    expect(f.deps.sandbox.discardSandboxState).toHaveBeenCalled();
  });

  it("retains the pending handle for a graceful archive during startup", async () => {
    const f = pendingVmFixture();
    await pendingVmReady(f);
    await f.shutdown.requestShutdown("archive");
    expect(f.shutdown.isHolding()).toBe(true);

    f.shutdown.prepared(preparedEvent(f.store.value!));
    await f.shutdown.handleAlarm();
    expect(f.takeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: PENDING_VM_REFERENCE })
    );
    expect(f.store.value?.phase).toBe("saved");
  });

  it("does not attach another generation's pending handle", async () => {
    const f = pendingVmFixture();
    const result = await f.shutdown.recordPendingProviderHandle(
      { ...GENERATION, createdAt: GENERATION.createdAt + 1 },
      "other-handle",
      {
        kind: "finite",
        expiresAtMs: 1_201_000,
        observedAtMs: GENERATION.createdAt,
        source: "conservative_start_bound",
      }
    );
    expect(result).toBe("superseded");
    expect(f.store.value).toMatchObject({ providerObjectId: null, lifetimeKind: "unknown" });
  });

  it("replaces a pending handle with a confirmed provider id", async () => {
    const f = pendingVmFixture();
    await pendingVmReady(f);
    f.sandboxRow.modal_object_id = "sb-confirmed";
    await f.shutdown.recordProviderStartup(GENERATION, {
      kind: "finite",
      expiresAtMs: 1_301_000,
      observedAtMs: GENERATION.createdAt,
      source: "conservative_start_bound",
    });
    expect(f.store.value?.providerObjectId).toBe("sb-confirmed");
    expect(f.store.value?.expiresAtMs).toBe(1_201_000);
  });

  it("commits a VM image before retiring its retained source", async () => {
    const takeSnapshot = vi.fn(async () => ({
      success: true as const,
      imageId: "vm-image",
      sourceStopped: false,
      sourceObjectId: "sb-immutable",
    }));
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(
      provider({
        name: "modal-vm",
        capabilities: { ...provider().capabilities, snapshotRequiresShutdown: true },
        takeSnapshot,
        stopSandbox,
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("execution_complete");
    f.shutdown.prepared(preparedEvent(f.store.value!));
    await f.shutdown.handleAlarm();

    expect(f.store.value).toMatchObject({
      phase: "saved",
      sourceRetired: true,
      receipt: {
        artifactId: "vm-image",
        provider: "modal-vm",
        sourceObjectId: "sb-immutable",
      },
    });
    expect(f.deps.sandbox.recordSandboxSnapshot).toHaveBeenCalledWith(
      GENERATION.sandboxId,
      "vm-image",
      "runtime-1"
    );
    expect(f.deps.sandbox.recordSandboxSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      stopSandbox.mock.invocationCallOrder[0]
    );
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "sb-immutable" })
    );
  });

  it("holds a lost VM capture response without retiring the source", async () => {
    const takeSnapshot = vi.fn(async () => {
      throw new Error("capture response lost");
    });
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(
      provider({
        name: "modal-vm",
        capabilities: { ...provider().capabilities, snapshotRequiresShutdown: true },
        takeSnapshot,
        stopSandbox,
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("inactivity_timeout");
    f.shutdown.prepared(preparedEvent(f.store.value!));
    await f.shutdown.handleAlarm();

    expect(f.store.value).toMatchObject({ phase: "unknown" });
    expect(stopSandbox).not.toHaveBeenCalled();
    // The source is kept, so it can be captured again.
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "discard"]);
  });

  it("does not capture over a checkpoint whose result a restart lost", async () => {
    const takeSnapshot = vi.fn();
    const f = fixture(provider({ takeSnapshot }));
    await readyFinite(f);
    await f.shutdown.requestShutdown("inactivity_timeout");
    f.store.write({ ...f.store.value!, checkpointInFlight: true });
    const restarted = new SandboxShutdownCoordinator(f.deps as never);

    f.setNow(f.store.value!.stopByMs!);
    await restarted.handleAlarm();

    expect(takeSnapshot).not.toHaveBeenCalled();
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      checkpointInFlight: true,
      error: "An earlier checkpoint has an unknown result.",
    });
    expect(recoveryActions(restarted)).not.toContain("retry");
  });

  it("distinguishes unmanaged and held shutdown requests", async () => {
    const f = fixture();

    await expect(f.shutdown.requestShutdown("checkpoint")).resolves.toBe("unmanaged");

    await readyFinite(f);
    f.sandboxRow.modal_sandbox_id = "replacement-sandbox";
    await expect(f.shutdown.requestShutdown("checkpoint")).resolves.toBe("held");
    expect(f.store.value).toMatchObject({ phase: "running", generation: GENERATION });
  });

  it("keeps a reconstructed legacy generation usable but checkpoint-gated", async () => {
    const f = fixture();
    reserveGeneration(f, GENERATION, "legacy");
    await f.shutdown.recordProviderStartup(GENERATION, {
      kind: "finite",
      expiresAtMs: 1_300_000,
      observedAtMs: 100_000,
      source: "provider",
    });
    f.shutdown.runtimeReady();

    const restarted = new SandboxShutdownCoordinator(f.deps as never);
    expect(restarted.admissionDecision()).not.toBe("held");
    await expect(restarted.requestShutdown("inactivity_timeout")).resolves.toBe("unmanaged");

    const mismatched = new SandboxShutdownCoordinator({
      ...f.deps,
      provider: provider({ name: "different-provider" }),
    } as never);
    expect(mismatched.admissionDecision()).toBe("held");
    await expect(mismatched.requestShutdown("inactivity_timeout")).resolves.toBe("held");
  });

  it("fails closed when a confirmed fresh runtime omits the protocol", async () => {
    const f = fixture();
    reserveGeneration(f, GENERATION, "confirmed");
    await f.shutdown.recordProviderStartup(GENERATION, { kind: "none", observedAtMs: 100_000 });

    f.shutdown.runtimeReady();

    expect(f.store.value).toMatchObject({
      phase: "failed",
      lifecyclePolicy: "confirmed",
      runtimeReady: true,
    });
    expect(f.shutdown.admissionDecision()).toBe("held");
  });

  it("derives one absolute stop/capture/retire budget and sends a correlated command", async () => {
    const f = fixture();
    await readyFinite(f);
    expect(f.shutdown.admissionDecision()).not.toBe("held");

    await expect(f.shutdown.requestShutdown("sandbox_lifetime_expiring")).resolves.toBe("owned");

    expect(f.store.value).toMatchObject({
      phase: "draining",
      stopByMs: 160_000,
      captureByMs: 460_000,
      retireByMs: 1_270_000,
    });
    expect(f.deps.sockets.send).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "prepare_preservation",
        operationId: f.store.value!.operationId,
        generation: GENERATION,
        stopByMs: 160_000,
      })
    );
    expect(f.shutdown.admissionDecision()).toBe("held");
  });

  it("settles session status from message state when shutdown begins between prompts", async () => {
    const f = fixture();
    await readyFinite(f);
    f.backgroundTasks.length = 0;

    await expect(f.shutdown.requestShutdown("inactivity_timeout")).resolves.toBe("owned");
    await Promise.all(f.backgroundTasks.map((task) => task()));

    expect(f.deps.failures.record).not.toHaveBeenCalled();
    expect(f.deps.reconcileStatusFromMessages).toHaveBeenCalledOnce();
  });

  it("requires a matching generation acknowledgement and ignores a late generation", async () => {
    const f = fixture();
    reserveGeneration(f, GENERATION, "confirmed");
    await f.shutdown.recordProviderStartup(GENERATION, {
      kind: "none",
      observedAtMs: 100_000,
    });
    f.shutdown.runtimeReady(1);
    expect(f.shutdown.admissionDecision()).toBe("held");

    f.shutdown.generationReady({
      type: "sandbox_generation_ready",
      generation: { ...GENERATION, createdAt: 999 },
      sandboxId: GENERATION.sandboxId,
      timestamp: 1,
    });
    expect(f.shutdown.admissionDecision()).toBe("held");

    f.shutdown.generationReady({
      type: "sandbox_generation_ready",
      generation: GENERATION,
      sandboxId: GENERATION.sandboxId,
      timestamp: 1,
    });
    expect(f.shutdown.admissionDecision()).not.toBe("held");
  });

  it.each([
    { bufferMs: 300_000, alarmDelayMs: 0, captureMs: 180_000 },
    { bufferMs: 300_000, alarmDelayMs: 30_000, captureMs: 150_000 },
    { bufferMs: 600_000, alarmDelayMs: 0, captureMs: 300_000 },
  ])(
    "preserves within buffer $bufferMs with alarm delay $alarmDelayMs",
    async ({ bufferMs, alarmDelayMs, captureMs }) => {
      const takeSnapshot = vi.fn(async () => ({
        success: true,
        imageId: "final-image",
        sourceStopped: true,
      }));
      const f = fixture(provider({ takeSnapshot }));
      f.deps.session.getSession.mockReturnValue({
        id: "session-1",
        session_name: "external-session-1",
        sandbox_settings: JSON.stringify({ finalSnapshotBufferMs: bufferMs }),
      });
      const expiresAtMs = 1_300_000;
      await readyFinite(f, expiresAtMs);
      expect(f.store.value?.drainAtMs).toBe(expiresAtMs - bufferMs);
      const alarmAtMs = expiresAtMs - bufferMs + alarmDelayMs;
      f.setNow(alarmAtMs);
      await f.shutdown.handleAlarm();

      const state = f.store.value!;
      expect(state.phase).toBe("draining");
      expect(state.stopByMs).toBe(alarmAtMs + 60_000);
      expect(state.captureByMs).toBe(state.stopByMs! + captureMs);
      expect(state.captureByMs).toBeLessThanOrEqual(expiresAtMs - 60_000);
      expect(state.retireByMs).toBe(expiresAtMs - 30_000);

      f.setNow(state.stopByMs! - 1);
      f.shutdown.prepared(preparedEvent(state));
      await f.shutdown.handleAlarm();
      expect(takeSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ deadlineAtMs: state.captureByMs })
      );
      expect(f.store.value?.phase).toBe("saved");
    }
  );

  it("pins an active generation to the provider that created it", async () => {
    const f = fixture(provider({ name: "modal" }));
    await readyFinite(f);
    f.store.write({ ...f.store.value!, provider: "e2b" });

    expect(f.shutdown.admissionDecision()).toBe("held");
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      error: expect.stringContaining("provider changed"),
    });
  });

  it("allows a fresh-spawn retry after startup fails with a prior provider handle", () => {
    const f = fixture();
    f.sandboxRow.status = "failed";
    reserveGeneration(f, GENERATION, "confirmed");

    expect(f.store.value).toMatchObject({
      phase: "running",
      provider: "modal",
      providerObjectId: null,
      lifetimeKind: "unknown",
    });
    expect(f.shutdown.admissionDecision()).not.toBe("held");
  });

  it("serializes final preparation behind an ordinary checkpoint", async () => {
    let resolve!: (value: { success: true; imageId: string }) => void;
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(
          () => new Promise<{ success: true; imageId: string }>((done) => (resolve = done))
        ),
      })
    );
    await readyFinite(f);
    const checkpoint = f.shutdown.captureCheckpoint(GENERATION, "checkpoint", "continue");

    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    expect(f.deps.sockets.send).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prepare_preservation" })
    );

    resolve({ success: true, imageId: "checkpoint-image" });
    await expect(checkpoint).resolves.toMatchObject({ outcome: "saved" });
    await f.backgroundTasks.at(-1)!();
    expect(f.deps.sockets.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prepare_preservation" })
    );
  });

  it("rejects a checkpoint without capture headroom so final graceful shutdown can start", async () => {
    const f = fixture();
    await readyFinite(f, 1_000_000);

    await expect(
      f.shutdown.captureCheckpoint(GENERATION, "checkpoint", "continue")
    ).resolves.toEqual({
      outcome: "held",
    });
    await expect(f.shutdown.requestShutdown("sandbox_lifetime_expiring")).resolves.toBe("owned");
    expect(f.deps.sockets.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prepare_preservation" })
    );
  });

  it("rejects checkpoints until a confirmed generation is ready", async () => {
    const f = fixture();
    reserveGeneration(f, GENERATION, "confirmed");

    await expect(
      f.shutdown.captureCheckpoint(GENERATION, "checkpoint", "continue")
    ).resolves.toEqual({
      outcome: "held",
    });
  });

  it("bounds a checkpoint and holds an uncertain provider outcome", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const f = fixture(
        provider({
          takeSnapshot: vi.fn(async (config) => {
            signal = config.signal;
            return new Promise<never>(() => {});
          }),
        })
      );
      await readyWithoutDeadline(f);
      const run = f.shutdown.captureCheckpoint(GENERATION, "heartbeat_timeout", "stop_source");

      await vi.advanceTimersByTimeAsync(300_000);
      await expect(run).resolves.toEqual({ outcome: "unknown" });
      expect(signal?.aborted).toBe(true);
      expect(f.store.value).toMatchObject({ phase: "unknown", checkpointInFlight: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a late checkpoint result write into a replacement generation", async () => {
    let resolve!: (value: { success: true; imageId: string }) => void;
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(
          () => new Promise<{ success: true; imageId: string }>((done) => (resolve = done))
        ),
      })
    );
    await readyWithoutDeadline(f);
    const oldCapture = f.shutdown.captureCheckpoint(GENERATION, "checkpoint", "continue");
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    const replacement = { sandboxId: "sandbox-2", createdAt: 2_000 };
    f.sandboxRow.modal_sandbox_id = replacement.sandboxId;
    f.sandboxRow.created_at = replacement.createdAt;
    reserveGeneration(f, replacement, "legacy");
    resolve({ success: true, imageId: "late-image" });
    await expect(oldCapture).resolves.toEqual({ outcome: "unknown" });
    expect(f.store.value).toMatchObject({ generation: replacement });
  });

  it("settles the active message once when duplicate shutdown requests race", async () => {
    const f = fixture();
    f.deps.messages.getProcessingMessage.mockReturnValue({ id: "message-1" });
    f.deps.failures.record.mockReturnValue({ id: "failure-1" });
    await readyFinite(f);
    f.backgroundTasks.length = 0;
    f.deps.reconcileStatusFromMessages.mockImplementation(async () => {
      expect(f.deps.failures.record).toHaveBeenCalledWith(
        "message-1",
        "The sandbox reached its maximum lifetime.",
        100_000,
        "processing"
      );
    });

    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    await Promise.all(f.backgroundTasks.map((task) => task()));

    expect(f.deps.failures.record).toHaveBeenCalledOnce();
    expect(f.deps.failures.record).toHaveBeenCalledWith(
      "message-1",
      "The sandbox reached its maximum lifetime.",
      100_000,
      "processing"
    );
    expect(f.deps.failures.deliver).toHaveBeenCalledOnce();
    expect(f.store.value?.messageId).toBe("message-1");
    expect(f.deps.reconcileStatusFromMessages).toHaveBeenCalledOnce();
  });

  it("ignores duplicate prepared evidence after the durable phase transition", async () => {
    const f = fixture();
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    const event = preparedEvent(f.store.value!);
    f.backgroundTasks.length = 0;

    f.shutdown.prepared(event);
    f.shutdown.prepared(event);

    expect(f.store.value?.phase).toBe("prepared");
    expect(f.backgroundTasks).toHaveLength(1);
  });

  it("replays the same correlated preparation after restart while draining", async () => {
    const f = fixture();
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    const operationId = f.store.value!.operationId;
    f.deps.sockets.send.mockClear();

    const restarted = new SandboxShutdownCoordinator({ ...f.deps, store: f.store } as never);
    expect(await restarted.handleAlarm()).toBe("hold_watchdogs");

    expect(f.deps.sockets.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prepare_preservation", operationId })
    );
  });

  it("marks an in-flight provider capture unknown after coordinator restart", async () => {
    const f = fixture();
    f.store.write({
      phase: "capturing",
      generation: GENERATION,
      providerObjectId: "provider-object-1",
      lifetimeKind: "finite",
      expiresAtMs: 1_300_000,
      drainAtMs: 700_000,
      generationReady: true,
      protocolVersion: 1,
      operationId: "operation-1",
      stopByMs: 160_000,
      captureByMs: 460_000,
      retireByMs: 1_270_000,
    });

    expect(await f.shutdown.handleAlarm()).toBe("hold_watchdogs");
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      error: expect.stringContaining("result is unknown"),
    });
    expect(f.deps.provider.takeSnapshot).toBeUndefined();
  });

  it("commits a snapshot receipt before retiring an independently captured source", async () => {
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          f.calls.push("provider-snapshot");
          return { success: true, imageId: "image-1", sourceStopped: false };
        }),
        stopSandbox: vi.fn(async () => {
          f.calls.push("provider-stop");
          expect(f.store.value).toMatchObject({
            phase: "retiring",
            receipt: { kind: "snapshot", artifactId: "image-1" },
          });
          return { success: true };
        }),
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.shutdown.prepared(preparedEvent(f.store.value!));

    await f.shutdown.handleAlarm();

    expect(f.store.value).toMatchObject({
      phase: "saved",
      receipt: { kind: "snapshot", artifactId: "image-1", provider: "modal" },
    });
    expect(f.calls.indexOf("phase:retiring")).toBeLessThan(f.calls.indexOf("provider-stop"));
    expect(f.calls.indexOf("snapshot-recorded")).toBeLessThan(f.calls.indexOf("provider-stop"));
    expect(f.calls).toContain("access-retired");
  });

  it("reconciles a committed receipt by retiring after coordinator restart", async () => {
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const f = fixture(provider({ stopSandbox }));
    f.store.write({
      phase: "retiring",
      generation: GENERATION,
      providerObjectId: "provider-object-1",
      lifetimeKind: "finite",
      expiresAtMs: 1_300_000,
      drainAtMs: 700_000,
      generationReady: true,
      protocolVersion: 1,
      operationId: "operation-1",
      reason: "sandbox_lifetime_expiring",
      stopByMs: 160_000,
      captureByMs: 460_000,
      retireByMs: 1_270_000,
      receipt: {
        kind: "snapshot",
        artifactId: "image-1",
        provider: "modal",
        savedAtMs: 150_000,
        runtimeVersion: "runtime-1",
      },
      savedAtMs: 150_000,
    });

    expect(await f.shutdown.handleAlarm()).toBe("hold_watchdogs");
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(f.store.value?.phase).toBe("saved");
  });

  it.each(["e2b", "daytona"])(
    "uses retained-object shutdown for %s without fabricating a snapshot id",
    async (name) => {
      const stopSandbox = vi.fn(async () => ({ success: true }));
      const takeSnapshot = vi.fn();
      const f = fixture(
        provider({
          name,
          capabilities: {
            supportsSandboxTimeout: name === "e2b",
            supportsSnapshots: false,
            supportsRestore: false,
            supportsPersistentResume: true,
            supportsExplicitStop: true,
          },
          stopSandbox,
          takeSnapshot,
        })
      );
      if (name === "daytona") await readyWithoutDeadline(f);
      else await readyFinite(f);
      await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
      f.shutdown.prepared(preparedEvent(f.store.value!));

      await f.shutdown.handleAlarm();

      expect(stopSandbox).toHaveBeenCalledTimes(1);
      expect(takeSnapshot).not.toHaveBeenCalled();
      expect(f.store.value).toMatchObject({
        phase: "saved",
        receipt: {
          kind: "retained",
          artifactId: "provider-object-1",
          provider: name,
        },
      });
      expect(f.deps.sandbox.recordSandboxSnapshot).not.toHaveBeenCalled();
    }
  );

  it("does not retire a destructive-snapshot source twice", async () => {
    const stopSandbox = vi.fn();
    const f = fixture(
      provider({
        name: "vercel",
        takeSnapshot: vi.fn(async () => ({
          success: true,
          imageId: "snapshot-1",
          sourceStopped: true,
        })),
        stopSandbox,
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.shutdown.prepared(preparedEvent(f.store.value!));

    await f.shutdown.handleAlarm();

    expect(stopSandbox).not.toHaveBeenCalled();
    expect(f.store.value?.phase).toBe("saved");
  });

  it("prefers an independent checkpoint for OpenComputer without a hard expiry", async () => {
    const takeSnapshot = vi.fn(async () => ({
      success: true,
      imageId: "checkpoint-1",
      sourceStopped: false,
    }));
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const f = fixture(
      provider({
        name: "opencomputer",
        capabilities: {
          supportsSandboxTimeout: true,
          supportsSnapshots: true,
          supportsRestore: true,
          supportsPersistentResume: true,
          supportsExplicitStop: true,
        },
        takeSnapshot,
        stopSandbox,
      })
    );
    await readyWithoutDeadline(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.shutdown.prepared(preparedEvent(f.store.value!));

    await f.shutdown.handleAlarm();

    expect(takeSnapshot).toHaveBeenCalledOnce();
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(f.store.value).toMatchObject({
      phase: "saved",
      receipt: { kind: "snapshot", artifactId: "checkpoint-1" },
    });
  });

  it("drops a late capture result after the sandbox generation changes", async () => {
    let resolveCapture!: (value: {
      success: true;
      imageId: string;
      sourceStopped: boolean;
    }) => void;
    const capture = new Promise<{
      success: true;
      imageId: string;
      sourceStopped: boolean;
    }>((resolve) => {
      resolveCapture = resolve;
    });
    const f = fixture(provider({ takeSnapshot: vi.fn(() => capture) }));
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.shutdown.prepared(preparedEvent(f.store.value!));
    const advancing = f.shutdown.handleAlarm();
    await vi.waitFor(() => expect(f.store.value?.phase).toBe("capturing"));

    const replacement = { sandboxId: "sandbox-2", createdAt: 2_000 };
    f.sandboxRow.modal_sandbox_id = replacement.sandboxId;
    f.sandboxRow.created_at = replacement.createdAt;
    reserveGeneration(f, replacement, "confirmed");
    resolveCapture({ success: true, imageId: "late-image", sourceStopped: false });
    await advancing;

    expect(f.store.value).toMatchObject({ phase: "running", generation: replacement });
    expect(f.deps.sandbox.recordSandboxSnapshot).not.toHaveBeenCalled();
  });

  it("times out an ambiguous capture without retiring the source", async () => {
    vi.useFakeTimers();
    try {
      const stopSandbox = vi.fn();
      const f = fixture(
        provider({
          takeSnapshot: vi.fn(() => new Promise<never>(() => undefined)),
          stopSandbox,
        })
      );
      await readyFinite(f);
      await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
      f.shutdown.prepared(preparedEvent(f.store.value!));
      f.setNow(f.store.value!.captureByMs! - 1);

      const advancing = f.shutdown.handleAlarm();
      await vi.advanceTimersByTimeAsync(1);
      await advancing;

      expect(f.store.value).toMatchObject({
        phase: "unknown",
        error: expect.stringContaining("did not finish before its deadline"),
      });
      expect(stopSandbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("captures without the runtime when it cannot confirm that execution stopped", async () => {
    const takeSnapshot = vi.fn(async () => ({
      success: true,
      imageId: "snapshot-1",
      sourceStopped: true,
    }));
    const f = fixture(provider({ takeSnapshot }));
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.backgroundTasks.length = 0;
    f.shutdown.prepared({
      ...preparedEvent(f.store.value!),
      executionStopped: false,
      error: "execution_stop_unconfirmed",
    });
    await Promise.all(f.backgroundTasks.splice(0).map((task) => task()));

    expect(takeSnapshot).toHaveBeenCalledOnce();
    // The capture cannot prove quiescence, so queued work waits for the user.
    expect(f.store.value).toMatchObject({ phase: "saved", continuationPaused: true });
    expect(f.deps.sandbox.updateSandboxStatus).toHaveBeenCalledWith("stale");
    expect(f.calls).toContain("access-retired");
  });

  it("captures without the runtime when the drain deadline passes", async () => {
    const takeSnapshot = vi.fn(async () => ({
      success: true,
      imageId: "snapshot-1",
      sourceStopped: true,
    }));
    const f = fixture(provider({ takeSnapshot }));
    f.deps.sockets.getSandboxSocket.mockReturnValue(null as never); // An unresponsive runtime.
    await readyFinite(f);
    await f.shutdown.requestShutdown("inactivity_timeout");
    expect(f.store.value?.phase).toBe("draining");

    f.setNow(f.store.value!.stopByMs!);
    await f.shutdown.handleAlarm();

    expect(takeSnapshot).toHaveBeenCalledOnce();
    expect(f.store.value).toMatchObject({
      phase: "saved",
      reason: "inactivity_timeout",
      continuationPaused: true,
    });
  });

  it("retries a failed capture as a new operation", async () => {
    const takeSnapshot = vi
      .fn<NonNullable<SandboxProvider["takeSnapshot"]>>()
      .mockRejectedValueOnce(new Error("guest unresponsive"))
      .mockResolvedValue({ success: true, imageId: "snapshot-2", sourceStopped: false });
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(provider({ takeSnapshot, stopSandbox }));
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    const failed = f.store.value!;
    expect(failed).toMatchObject({ phase: "unknown", continuationPaused: true });
    expect(stopSandbox).not.toHaveBeenCalled();
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "discard"]);

    await f.shutdown.recover("retry");

    expect(takeSnapshot).toHaveBeenCalledTimes(2);
    expect(f.store.value?.operationId).not.toBe(failed.operationId);
    expect(f.store.value).toMatchObject({
      phase: "saved",
      continuationPaused: true,
      receipt: { artifactId: "snapshot-2" },
    });
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "provider-object-1", intent: "destroy" })
    );
  });

  describe("alarm capture retries", () => {
    async function failedGracefulCapture() {
      const takeSnapshot = vi
        .fn<NonNullable<SandboxProvider["takeSnapshot"]>>()
        .mockRejectedValue(new Error("transient provider error"));
      const stopSandbox = vi.fn(async () => ({ success: true as const }));
      const f = fixture(provider({ takeSnapshot, stopSandbox }));
      await readyWithoutDeadline(f);
      await f.shutdown.requestShutdown("inactivity_timeout");
      f.shutdown.prepared(preparedEvent(f.store.value!));
      await f.shutdown.handleAlarm();
      expect(f.store.value?.phase).toBe("unknown");
      expect(f.sandboxRow.status).toBe("ready");
      expect(f.deps.sandbox.updateSandboxStatus).not.toHaveBeenCalled();
      f.deps.alarm.schedule.mockClear();
      f.backgroundTasks.length = 0;
      return { ...f, takeSnapshot, stopSandbox };
    }

    it("reasserts the capture deadline after an earlier alarm without retrying yet", async () => {
      const f = await failedGracefulCapture();
      const failed = f.store.value!;
      f.setNow(failed.captureByMs! - 1);

      await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");

      expect(f.takeSnapshot).toHaveBeenCalledOnce();
      expect(f.store.value).toEqual(failed);
      expect(f.deps.alarm.schedule).toHaveBeenCalledExactlyOnceWith(failed.captureByMs);
    });

    it.each(["provider rejection", "deadline timeout"] as const)(
      "re-arms a consumed in-flight alarm after %s",
      async (outcome) => {
        vi.useFakeTimers();
        try {
          let rejectCapture!: (error: Error) => void;
          const takeSnapshot = vi
            .fn<NonNullable<SandboxProvider["takeSnapshot"]>>()
            .mockImplementationOnce(
              () =>
                new Promise((_, reject) => {
                  rejectCapture = reject;
                })
            )
            .mockResolvedValue({ success: true, imageId: "retry-image", sourceStopped: true });
          const f = fixture(provider({ takeSnapshot }));
          let pendingAlarm: number | null = null;
          f.deps.alarm.schedule.mockImplementation(async (atMs) => {
            pendingAlarm = Math.min(pendingAlarm ?? Infinity, atMs);
          });
          await readyWithoutDeadline(f);
          await f.shutdown.requestShutdown("inactivity_timeout");
          f.shutdown.prepared(preparedEvent(f.store.value!));

          pendingAlarm = null;
          const capturing = f.shutdown.handleAlarm();
          await vi.advanceTimersByTimeAsync(0);
          const state = f.store.value!;
          expect(state.phase).toBe("capturing");
          if (outcome === "provider rejection") await f.deps.alarm.schedule(state.stopByMs!);
          expect(pendingAlarm).toBe(
            outcome === "provider rejection" ? state.stopByMs : state.captureByMs
          );
          f.setNow(pendingAlarm!);
          pendingAlarm = null;
          await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");
          expect(takeSnapshot).toHaveBeenCalledOnce();

          if (outcome === "provider rejection")
            rejectCapture(new Error("transient provider error"));
          else await vi.advanceTimersByTimeAsync(state.captureByMs! - 100_000);
          await capturing;
          await Promise.all(f.backgroundTasks.splice(0).map((task) => task()));

          expect(f.store.value?.phase).toBe("unknown");
          expect(pendingAlarm).toBe(state.captureByMs);
          f.setNow(pendingAlarm!);
          pendingAlarm = null;
          await f.shutdown.handleAlarm();
          expect(takeSnapshot).toHaveBeenCalledTimes(2);
          expect(f.store.value).toMatchObject({
            phase: "saved",
            receipt: { artifactId: "retry-image" },
          });
        } finally {
          vi.useRealTimers();
        }
      }
    );

    it.each(["failed", "unknown"] as const)(
      "retries a held %s capture at its deadline without a reconnect",
      async (phase) => {
        const f = await failedGracefulCapture();
        f.store.write({ ...f.store.value!, phase });
        const failed = f.store.value!;
        f.takeSnapshot.mockResolvedValue({
          success: true,
          imageId: "retry-image",
          sourceStopped: false,
        });
        f.setNow(failed.captureByMs!);

        await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");

        expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
        expect(f.takeSnapshot).toHaveBeenLastCalledWith(
          expect.objectContaining({ deadlineAtMs: failed.captureByMs! + 300_000 })
        );
        expect(f.store.value?.operationId).not.toBe(failed.operationId);
        expect(f.store.value).toMatchObject({
          phase: "saved",
          sourceRetired: true,
          receipt: { artifactId: "retry-image" },
        });
        expect(f.calls).toContain("phase:retiring");
        expect(f.stopSandbox).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ providerObjectId: "provider-object-1", intent: "destroy" })
        );
        expect(f.deps.sandbox.updateSandboxStatus).toHaveBeenCalledWith("stopped");
        expect(f.deps.log.info).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ event: "sandbox.preservation_retry", trigger: "alarm" })
        );
      }
    );

    it("runs only one timed-out retry per composed alarm delivery", async () => {
      vi.useFakeTimers();
      try {
        const f = await failedGracefulCapture();
        f.takeSnapshot
          .mockImplementationOnce(() => new Promise(() => {}))
          .mockResolvedValue({ success: true, imageId: "retry-image", sourceStopped: true });
        f.setNow(f.store.value!.captureByMs!);
        const preserve = vi.fn((allowCaptureRetry?: boolean) =>
          f.shutdown.handleAlarm(allowCaptureRetry)
        );
        const flushPending = vi.fn(async () => {});
        const recoverStopConfirmationTimeout = vi.fn();
        const handler = createAlarmHandler({
          preserveBeforeWatchdogs: preserve,
          terminalMessageProjection: { flushPending },
          executionStop: { recoverStopConfirmationTimeout },
          repository: {
            getProcessingMessageWithStartedAt: vi.fn(() => null),
            getNextPendingMessage: vi.fn(() => null),
          },
          lifecycleManager: { handleAlarm: vi.fn(async () => "no_action") },
          log: f.deps.log,
        } as never);

        const delivery = handler.handle();
        await vi.advanceTimersByTimeAsync(0);
        expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
        f.setNow(f.store.value!.captureByMs!);
        await vi.advanceTimersByTimeAsync(300_000);
        await delivery;

        expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
        expect(f.store.value?.phase).toBe("unknown");
        expect(f.shutdown.snapshot()).not.toHaveProperty("captureFailure");
        expect(flushPending).toHaveBeenCalledOnce();
        expect(recoverStopConfirmationTimeout).not.toHaveBeenCalled();
        await handler.handle();
        expect(f.takeSnapshot).toHaveBeenCalledTimes(3);
        expect(f.store.value?.phase).toBe("saved");
      } finally {
        vi.useRealTimers();
      }
    });

    it("spaces repeated failures by capture windows without extending the retry window", async () => {
      const f = await failedGracefulCapture();
      const stopByMs = f.store.value!.stopByMs!;
      const retryEndMs = stopByMs + 30 * 60_000;

      for (let attempt = 2; attempt <= 6; attempt++) {
        const failed = f.store.value!;
        f.deps.alarm.schedule.mockClear();
        f.setNow(failed.captureByMs! - 1);
        await f.shutdown.handleAlarm();
        expect(f.takeSnapshot).toHaveBeenCalledTimes(attempt - 1);
        expect(f.deps.alarm.schedule).toHaveBeenCalledWith(failed.captureByMs);

        f.setNow(failed.captureByMs!);
        await f.shutdown.handleAlarm();
        expect(f.takeSnapshot).toHaveBeenCalledTimes(attempt);
        expect(f.store.value).toMatchObject({
          phase: "unknown",
          stopByMs,
          captureByMs: failed.captureByMs! + 300_000,
        });
        expect(f.store.value?.operationId).not.toBe(failed.operationId);
      }

      expect(f.store.value?.captureByMs).toBe(retryEndMs);
      f.deps.alarm.schedule.mockClear();
      for (const now of [retryEndMs, retryEndMs + 300_000]) {
        f.setNow(now);
        await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");
      }
      expect(f.takeSnapshot).toHaveBeenCalledTimes(6);
      expect(f.deps.alarm.schedule).not.toHaveBeenCalled();
      expect(f.stopSandbox).not.toHaveBeenCalled();
      expect(recoveryActions(f.shutdown)).not.toContain("retry");
    });

    it.each([
      { discarding: "discard-operation" },
      { restoreInvoked: true },
      { checkpointInFlight: true },
      { sourceRetired: true },
      { providerObjectId: null },
      { provider: "other-provider" },
      { expiresAtMs: 500_000, lifetimeKind: "finite" as const },
      {
        receipt: {
          kind: "snapshot" as const,
          artifactId: "saved-image",
          provider: "modal",
          savedAtMs: 100_000,
          runtimeVersion: "runtime-1",
        },
      },
      {
        receipt: {
          kind: "snapshot" as const,
          artifactId: "older-image",
          provider: "other-provider",
          savedAtMs: 500,
          runtimeVersion: "runtime-1",
        },
      },
    ])("does not retry an ineligible held capture (%j)", async (changes) => {
      const f = await failedGracefulCapture();
      f.store.write({ ...f.store.value!, ...changes });
      f.setNow(f.store.value!.captureByMs!);

      await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");

      expect(f.takeSnapshot).toHaveBeenCalledOnce();
      expect(f.deps.alarm.schedule).not.toHaveBeenCalled();
      expect(f.store.value?.phase).toBe("unknown");
    });

    it("does not retry a superseded generation", async () => {
      const f = await failedGracefulCapture();
      f.sandboxRow.created_at += 1;
      f.setNow(f.store.value!.captureByMs!);

      await f.shutdown.handleAlarm();

      expect(f.takeSnapshot).toHaveBeenCalledOnce();
      expect(f.deps.alarm.schedule).not.toHaveBeenCalled();
    });

    it("does not overlap an active capture even if its record is held", async () => {
      const f = await failedGracefulCapture();
      let resolveCapture!: (value: { success: true; imageId: string; sourceStopped: true }) => void;
      f.takeSnapshot.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCapture = resolve;
          })
      );
      const retry = f.shutdown.recover("retry");
      await vi.waitFor(() => expect(f.takeSnapshot).toHaveBeenCalledTimes(2));
      f.store.write({ ...f.store.value!, phase: "unknown" });
      f.setNow(f.store.value!.captureByMs!);
      f.deps.alarm.schedule.mockClear();

      try {
        await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");
        expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
        expect(f.deps.alarm.schedule).not.toHaveBeenCalled();
      } finally {
        resolveCapture({ success: true, imageId: "late-image", sourceStopped: true });
        await retry;
      }
    });

    it("does not retry a failed restore that has no capture deadlines", async () => {
      const takeSnapshot = vi.fn();
      const f = fixture(provider({ takeSnapshot }));
      await readyWithoutDeadline(f);
      f.store.write({
        ...f.store.value!,
        receipt: {
          kind: "snapshot",
          artifactId: "older-image",
          provider: "modal",
          savedAtMs: 500,
          runtimeVersion: "runtime-1",
        },
      });
      f.shutdown.holdFailedRecovery("restore failed", GENERATION);
      expect(f.store.value).toMatchObject({ phase: "unknown", sourceRetired: false });
      expect(f.store.value?.stopByMs).toBeUndefined();
      f.setNow(460_000);

      await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");

      expect(takeSnapshot).not.toHaveBeenCalled();
      expect(f.deps.alarm.schedule).not.toHaveBeenCalled();
    });

    it("retries a capture interrupted by restart on a later due alarm", async () => {
      const f = await failedGracefulCapture();
      f.store.write({ ...f.store.value!, phase: "capturing" });
      f.takeSnapshot.mockResolvedValue({
        success: true,
        imageId: "retry-image",
        sourceStopped: true,
      });
      const restarted = new SandboxShutdownCoordinator(f.deps as never);

      await restarted.handleAlarm();
      expect(f.store.value).toMatchObject({
        phase: "unknown",
        error: expect.stringContaining("control-plane restart"),
      });
      expect(f.takeSnapshot).toHaveBeenCalledOnce();
      await restarted.handleAlarm();
      expect(f.deps.alarm.schedule).toHaveBeenCalledWith(f.store.value!.captureByMs);

      f.setNow(f.store.value!.captureByMs!);
      await restarted.handleAlarm();

      expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
      expect(f.store.value).toMatchObject({
        phase: "saved",
        receipt: { artifactId: "retry-image" },
      });
    });

    it.each(["alarm", "reconnect"] as const)(
      "does not double fire when the %s retry wins a race",
      async (first) => {
        const f = await failedGracefulCapture();
        f.setNow(f.store.value!.captureByMs!);
        expect(f.shutdown.onRefusedReconnect()).toBe("retry");
        const reconnectRetry = f.backgroundTasks.splice(0)[0]!;

        if (first === "alarm") {
          await f.shutdown.handleAlarm();
          await reconnectRetry();
        } else {
          await reconnectRetry();
          await f.shutdown.handleAlarm();
        }

        await Promise.all(f.backgroundTasks.splice(0).map((task) => task()));
        expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
        expect(f.store.value?.phase).toBe("unknown");
        expect(f.shutdown.onRefusedReconnect()).toBe("retry");
        expect(f.backgroundTasks).toHaveLength(0);
        expect(f.deps.alarm.schedule).toHaveBeenCalledWith(f.store.value!.captureByMs);
        expect(
          f.deps.log.info.mock.calls.filter(
            ([, fields]) => fields.event === "sandbox.preservation_retry"
          )
        ).toEqual([[expect.any(String), expect.objectContaining({ trigger: first })]]);
      }
    );
  });

  it("stops offering a retry once the window after the shutdown closes", async () => {
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          throw new Error("guest unresponsive");
        }),
        stopSandbox: vi.fn(async () => ({ success: true as const })),
      })
    );
    await readyWithoutDeadline(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    const failed = f.store.value!;

    f.setNow(failed.stopByMs! + 30 * 60_000 - 1);
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "discard"]);
    f.setNow(failed.stopByMs! + 30 * 60_000);
    expect(recoveryActions(f.shutdown)).toEqual(["discard"]);
    await expect(f.shutdown.recover("retry")).rejects.toThrow("Shutdown recovery is unavailable");
    // The runtime is no longer kept up for a save.
    expect(f.shutdown.onRefusedReconnect()).toBe("exit");
  });

  it("keeps a refused runtime up while its source is being captured", async () => {
    let resolveCapture!: (value: { success: true; imageId: string; sourceStopped: true }) => void;
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(
          () =>
            new Promise<{ success: true; imageId: string; sourceStopped: true }>(
              (resolve) => (resolveCapture = resolve)
            )
        ),
      })
    );
    await readyFinite(f);
    expect(f.shutdown.onRefusedReconnect()).toBe("exit");

    const capture = f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    await vi.waitFor(() => expect(f.store.value?.phase).toBe("capturing"));
    expect(f.shutdown.onRefusedReconnect()).toBe("retry");

    resolveCapture({ success: true, imageId: "image-1", sourceStopped: true });
    await capture;
    expect(f.store.value?.phase).toBe("saved");
    expect(f.shutdown.onRefusedReconnect()).toBe("exit");
  });

  it("retries a failed save when the runtime reconnects after the capture window", async () => {
    const takeSnapshot = vi
      .fn<NonNullable<SandboxProvider["takeSnapshot"]>>()
      .mockRejectedValueOnce(new Error("guest unresponsive"))
      .mockResolvedValue({ success: true, imageId: "snapshot-2", sourceStopped: false });
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(provider({ takeSnapshot, stopSandbox }));
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    const failed = f.store.value!;
    f.backgroundTasks.length = 0;

    // Within the failed attempt's own window the runtime is kept, but not captured again.
    expect(f.shutdown.onRefusedReconnect()).toBe("retry");
    expect(f.backgroundTasks).toHaveLength(0);

    f.setNow(failed.captureByMs!);
    expect(f.shutdown.onRefusedReconnect()).toBe("retry");
    expect(f.backgroundTasks).toHaveLength(1);
    // A second reconnect before the retry runs does not start another capture.
    expect(f.shutdown.onRefusedReconnect()).toBe("retry");
    await Promise.all(f.backgroundTasks.splice(0).map((task) => task()));

    expect(takeSnapshot).toHaveBeenCalledTimes(2);
    expect(f.store.value).toMatchObject({ phase: "saved", receipt: { artifactId: "snapshot-2" } });
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(f.shutdown.onRefusedReconnect()).toBe("exit");
  });

  it("discards a held sandbox by stopping its source and making the next start fresh", async () => {
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          throw new Error("capture failed");
        }),
        stopSandbox,
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    f.store.write({
      ...f.store.value!,
      receipt: {
        kind: "snapshot",
        artifactId: "older-image",
        provider: "modal",
        savedAtMs: 500,
        runtimeVersion: "runtime-1",
      },
    });
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "restore_saved", "discard"]);
    // Clients whose schema predates discard still parse the action list.
    expect(f.shutdown.snapshot()).toMatchObject({
      availableRecoveryActions: ["retry", "restore_saved"],
      discardAvailable: true,
    });
    f.deps.background.submit.mockClear();

    await f.shutdown.recover("discard");

    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        providerObjectId: "provider-object-1",
        reason: "discard",
        intent: "destroy",
      })
    );
    expect(f.deps.sandbox.discardSandboxState).toHaveBeenCalledWith(GENERATION);
    expect(f.store.value).toMatchObject({
      phase: "running",
      providerObjectId: null,
      sourceRetired: true,
    });
    expect(f.store.value?.receipt).toBeUndefined();
    expect(f.shutdown.snapshot()).toMatchObject({
      phase: "running",
      hasRecoveryPoint: false,
      availableRecoveryActions: [],
      discardAvailable: false,
    });
    expect(f.shutdown.isHolding()).toBe(false);
    expect(f.shutdown.startupDecision()).toEqual({ kind: "normal" });
    expect(f.shutdown.admissionDecision()).toBe("spawn_required");
    expect(f.deps.background.submit).toHaveBeenCalledWith(expect.any(Function), {
      name: "sandbox.lifecycle_change",
    });
  });

  it("claims a discard durably so no other recovery can act while its source stops", async () => {
    let resolveStop!: (value: { success: true }) => void;
    const stopSandbox = vi.fn(
      () => new Promise<{ success: true }>((resolve) => (resolveStop = resolve))
    );
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          throw new Error("capture failed");
        }),
        stopSandbox,
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    f.store.write({
      ...f.store.value!,
      receipt: {
        kind: "snapshot",
        artifactId: "older-image",
        provider: "modal",
        savedAtMs: 500,
        runtimeVersion: "runtime-1",
      },
    });
    const operationId = f.store.value!.operationId;

    const discarding = f.shutdown.recover("discard");
    await vi.waitFor(() => expect(stopSandbox).toHaveBeenCalledOnce());

    expect(f.store.value).toMatchObject({ discarding: expect.any(String), operationId });
    expect(recoveryActions(f.shutdown)).toEqual([]);
    await expect(f.shutdown.recover("retry")).rejects.toThrow("Shutdown recovery is unavailable");
    await expect(f.shutdown.recover("restore_saved")).rejects.toThrow(
      "Shutdown recovery is unavailable"
    );
    await expect(f.shutdown.recover("discard")).rejects.toThrow("Shutdown recovery is unavailable");
    expect(f.shutdown.onRefusedReconnect()).toBe("exit");

    resolveStop({ success: true });
    await discarding;
    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(f.store.value).toMatchObject({ phase: "running", providerObjectId: null });
    expect(f.store.value?.discarding).toBeUndefined();
  });

  it("lets a discard interrupted by a restart be completed, and only completed", async () => {
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(provider({ stopSandbox, takeSnapshot: vi.fn() }));
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "unknown",
      error: "capture outcome unknown",
      operationId: "failed-capture",
      stopByMs: 100_000,
      captureByMs: 400_000,
      retireByMs: 1_270_000,
      discarding: "interrupted-discard",
    });
    const restarted = new SandboxShutdownCoordinator(f.deps as never);

    expect(recoveryActions(restarted)).toEqual(["discard"]);
    await restarted.recover("discard");

    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "provider-object-1", reason: "discard" })
    );
    expect(f.store.value).toMatchObject({ phase: "running", providerObjectId: null });
  });

  it("keeps the hold when the source cannot be stopped for a discard", async () => {
    const stopSandbox = vi.fn(async () => ({ success: false as const, error: "unavailable" }));
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          throw new Error("capture failed");
        }),
        stopSandbox,
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");

    await f.shutdown.recover("discard");

    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(f.deps.sandbox.discardSandboxState).not.toHaveBeenCalled();
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      providerObjectId: "provider-object-1",
      error: expect.stringContaining("could not be stopped"),
    });
    // The claim is released, so every recovery is available again.
    expect(f.store.value?.discarding).toBeUndefined();
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "discard"]);
  });

  it("retires this generation's source, not an older receipt's, before restoring it", async () => {
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(provider({ stopSandbox }));
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "unknown",
      error: "capture outcome unknown",
      receipt: {
        kind: "snapshot",
        artifactId: "last-good-image",
        sourceObjectId: "previous-generation-source",
        provider: "modal",
        savedAtMs: 500,
        runtimeVersion: "runtime-1",
      },
    });

    await f.shutdown.recover("restore_saved");

    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(stopSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ providerObjectId: "provider-object-1" })
    );
    expect(f.store.value).toMatchObject({
      phase: "saved",
      receipt: { artifactId: "last-good-image" },
    });
  });

  it("retries a boot that died after the provider created its sandbox", async () => {
    const f = fixture();
    reserveGeneration(f, GENERATION, "confirmed");
    await f.shutdown.recordProviderStartup(GENERATION, { kind: "none", observedAtMs: 100_000 });
    expect(f.store.value).toMatchObject({ providerObjectId: "provider-object-1" });
    expect(f.shutdown.admissionDecision()).toBe("held");

    for (const status of ["failed", "stale"]) {
      f.sandboxRow.status = status;
      expect(f.shutdown.admissionDecision()).toBe("spawn_required");
    }
    // A runtime that became ready may have served work, so its loss is never a fresh start.
    f.shutdown.runtimeReady(1);
    expect(f.shutdown.admissionDecision()).toBe("held");
  });

  it("projects exactly the recovery actions accepted for the current provider and phase", async () => {
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          throw new Error("capture failed");
        }),
        stopSandbox: vi.fn(async () => ({ success: true })),
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    expect(f.store.value?.phase).toBe("unknown");
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "discard"]);

    // A receipt carried from an earlier generation: save again, or go back to it.
    const receipt = {
      kind: "snapshot" as const,
      artifactId: "last-good-image",
      provider: "modal",
      savedAtMs: 500,
      runtimeVersion: "runtime-1",
    };
    f.store.write({ ...f.store.value!, receipt });
    expect(recoveryActions(f.shutdown)).toEqual(["retry", "restore_saved", "discard"]);

    // This generation's source is already captured, so it is restored, not captured again.
    f.store.write({ ...f.store.value!, receipt: { ...receipt, savedAtMs: 90_000 } });
    expect(recoveryActions(f.shutdown)).toEqual(["restore_saved", "discard"]);

    f.store.write({ ...f.store.value!, receipt, provider: "other" });
    expect(recoveryActions(f.shutdown)).toEqual([]);

    f.store.write({
      ...f.store.value!,
      provider: "modal",
      receipt: { ...receipt, provider: "other" },
    });
    expect(recoveryActions(f.shutdown)).toEqual([]);
    await expect(f.shutdown.recover("restore_saved")).rejects.toThrow(
      "Shutdown recovery is unavailable"
    );
    expect(f.store.value).toMatchObject({ phase: "unknown", receipt: { provider: "other" } });
  });

  it("does not clear a paused saved continuation with a mismatched receipt provider", async () => {
    const f = fixture();
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "saved",
      continuationPaused: true,
      receipt: {
        kind: "snapshot",
        artifactId: "saved-image",
        provider: "other",
        savedAtMs: 50_000,
        runtimeVersion: "runtime-1",
      },
    });

    expect(recoveryActions(f.shutdown)).toEqual([]);
    await expect(f.shutdown.recover("restore_saved")).rejects.toThrow();
    expect(f.store.value).toMatchObject({ phase: "saved", continuationPaused: true });
  });

  it.each([
    {
      name: "stale generation",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.sandboxRow.created_at += 1;
      },
    },
    {
      name: "discard of a generation that was replaced",
      action: "discard" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.sandboxRow.created_at += 1;
      },
    },
    {
      name: "missing source retirement operation",
      action: "restore_saved" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.store.write({
          ...f.store.value!,
          phase: "unknown",
          sourceRetired: false,
          receipt: {
            kind: "snapshot",
            artifactId: "saved-image",
            provider: "modal",
            savedAtMs: 50_000,
            runtimeVersion: "runtime-1",
          },
        });
      },
    },
    {
      name: "expired retry window",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.store.write({ ...f.store.value!, expiresAtMs: 100_000 });
      },
    },
    {
      name: "retired source",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.store.write({ ...f.store.value!, sourceRetired: true });
      },
    },
    {
      name: "retry after the retry window",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.setNow(f.store.value!.stopByMs! + 30 * 60_000);
      },
    },
    {
      name: "missing provider handle",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.store.write({ ...f.store.value!, providerObjectId: null });
      },
    },
  ])("rejects $name without advertising it", async ({ action, mutate }) => {
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => {
          throw new Error("capture failed");
        }),
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    expect(f.store.value?.phase).toBe("unknown");
    mutate(f);
    const before = structuredClone(f.store.value);

    expect(recoveryActions(f.shutdown)).not.toContain(action);
    await expect(f.shutdown.recover(action)).rejects.toThrow("Shutdown recovery is unavailable");
    expect(f.store.value).toEqual(before);
  });

  it("retires an unexpired source before restoring the last saved receipt", async () => {
    const stopSandbox = vi.fn(async () => ({ success: true }));
    const f = fixture(provider({ stopSandbox }));
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "unknown",
      error: "capture outcome unknown",
      receipt: {
        kind: "snapshot",
        artifactId: "last-good-image",
        provider: "modal",
        savedAtMs: 50_000,
        runtimeVersion: "runtime-1",
      },
    });
    f.deps.background.submit.mockClear();

    await f.shutdown.recover("restore_saved");

    expect(stopSandbox).toHaveBeenCalledOnce();
    expect(f.store.value).toMatchObject({
      phase: "saved",
      receipt: { artifactId: "last-good-image" },
    });
    expect(f.deps.background.submit).toHaveBeenCalledWith(expect.any(Function), {
      name: "sandbox.lifecycle_change",
    });
  });

  it("retains preflight retirement proof across restart without automatically retrying", async () => {
    const f = fixture();
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "saved",
      receipt: {
        kind: "snapshot",
        artifactId: "saved-image",
        provider: "modal",
        savedAtMs: 50_000,
        runtimeVersion: "runtime-1",
      },
    });
    const next = { ...GENERATION, createdAt: GENERATION.createdAt + 1 };
    f.sandboxRow.created_at = next.createdAt;
    reserveGeneration(f, next, "confirmed");
    f.shutdown.holdFailedRecovery("preflight failed", next);

    const restarted = new SandboxShutdownCoordinator(f.deps as never);
    expect(restarted.isHolding()).toBe(true);
    expect(restarted.admissionDecision()).toBe("held");
    expect(restarted.startupDecision().kind).toBe("hold");
    await restarted.recover("restore_saved");
    expect(restarted.snapshot()?.hasRecoveryPoint).toBe(true);
    expect(f.store.value?.sourceRetired).toBe(true);
  });

  it.each(["discard", "restore_saved"] as const)(
    "stops the allocation an interrupted restore created before %s",
    async (action) => {
      const stopSandbox = vi.fn(async () => ({ success: true as const }));
      const f = fixture(provider({ stopSandbox }));
      await readyFinite(f);
      f.store.write({
        ...f.store.value!,
        phase: "saved",
        sourceRetired: true,
        receipt: {
          kind: "snapshot",
          artifactId: "saved-image",
          provider: "modal",
          savedAtMs: 50_000,
          runtimeVersion: "runtime-1",
        },
      });
      const next = { sandboxId: "sandbox-2", createdAt: 2_000 };
      f.sandboxRow.modal_sandbox_id = next.sandboxId;
      f.sandboxRow.created_at = next.createdAt;
      reserveGeneration(f, next, "confirmed");
      f.shutdown.markRecoveryInvoked(next);
      f.sandboxRow.modal_object_id = "restored-provider-object";

      // The retirement proof still describes the source the restore replaced.
      expect(f.store.value).toMatchObject({ restoreInvoked: true, sourceRetired: true });
      const interrupted = new SandboxShutdownCoordinator(f.deps as never);
      expect(recoveryActions(interrupted)).toContain(action);
      await interrupted.recover(action);

      expect(stopSandbox).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ providerObjectId: "restored-provider-object", intent: "destroy" })
      );
      expect(f.store.value?.phase).toBe(action === "discard" ? "running" : "saved");
    }
  );

  it("holds an interrupted snapshot restore until explicit recovery from the retired source", async () => {
    const f = fixture();
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "saved",
      sourceRetired: true,
      receipt: {
        kind: "snapshot",
        artifactId: "saved-image",
        provider: "modal",
        savedAtMs: 50_000,
        runtimeVersion: "runtime-1",
      },
    });
    const next = { sandboxId: "sandbox-2", createdAt: 2_000 };
    f.sandboxRow.modal_sandbox_id = next.sandboxId;
    f.sandboxRow.created_at = next.createdAt;
    reserveGeneration(f, next, "confirmed");

    expect(f.store.value).toMatchObject({ phase: "restoring", restoreInvoked: false });
    const restarted = new SandboxShutdownCoordinator(f.deps as never);
    expect(restarted.isHolding()).toBe(false);
    expect(restarted.startupDecision()).toMatchObject({
      kind: "restore_snapshot",
      snapshotId: "saved-image",
    });

    f.shutdown.markRecoveryInvoked(next);
    f.sandboxRow.modal_object_id = "restored-provider-object";
    const interrupted = new SandboxShutdownCoordinator(f.deps as never);
    expect(interrupted.snapshot()).toMatchObject({ phase: "unknown", hasRecoveryPoint: true });
    await expect(interrupted.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(interrupted.isHolding()).toBe(true);
    expect(interrupted.startupDecision().kind).toBe("hold");
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      providerObjectId: "restored-provider-object",
      receipt: { artifactId: "saved-image" },
    });
    expect(recoveryActions(interrupted)).toEqual(["restore_saved", "discard"]);
    await interrupted.recover("restore_saved");
    expect(f.store.value).toMatchObject({
      phase: "saved",
      sourceRetired: true,
      receipt: { artifactId: "saved-image" },
    });
    expect(interrupted.startupDecision()).toMatchObject({
      kind: "restore_snapshot",
      snapshotId: "saved-image",
    });
  });

  it("accepts readiness for the active restore before the provider returns", async () => {
    const f = fixture();
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      phase: "saved",
      receipt: {
        kind: "retained",
        artifactId: "provider-object-1",
        provider: "modal",
        savedAtMs: 50_000,
        runtimeVersion: null,
      },
    });
    const next = { sandboxId: GENERATION.sandboxId, createdAt: 2_000 };
    f.sandboxRow.created_at = next.createdAt;
    reserveGeneration(f, next, "legacy");
    f.shutdown.markRecoveryInvoked(next, "provider-object-1");

    expect(f.shutdown.isHolding()).toBe(false);
    f.shutdown.runtimeReady();
    await f.shutdown.recordProviderStartup(next, { kind: "none", observedAtMs: 100_000 });
    expect(f.store.value).toMatchObject({ phase: "running", runtimeReady: true });
  });

  it("ignores failed restore publication and rejects startup from a superseded generation", async () => {
    const f = fixture();
    await readyFinite(f);
    f.store.write({
      ...f.store.value!,
      receipt: {
        kind: "snapshot",
        artifactId: "saved-image",
        provider: "modal",
        savedAtMs: 50_000,
        runtimeVersion: "runtime-1",
      },
    });
    const next = { ...GENERATION, createdAt: GENERATION.createdAt + 1 };
    f.sandboxRow.created_at = next.createdAt;
    reserveGeneration(f, next, "confirmed");
    const state = structuredClone(f.store.value);

    f.shutdown.holdFailedRecovery("late provider failure", GENERATION);
    expect(() => f.shutdown.markRecoveryInvoked(GENERATION)).toThrow("superseded");
    expect(f.store.value).toEqual(state);
  });

  it("keeps provider ownership but holds dispatch for an explicit unknown lifetime", async () => {
    const f = fixture();
    reserveGeneration(f, GENERATION, "confirmed");
    await f.shutdown.recordProviderStartup(GENERATION, {
      kind: "unknown",
      observedAtMs: 100_000,
      reason: "metadata unavailable",
    });
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      providerObjectId: "provider-object-1",
      sourceRetired: false,
    });
    expect(f.shutdown.admissionDecision()).toBe("held");
  });
});

describe("unconfirmed routine checkpoint settlement", () => {
  const SETTLE_AT_MS = 430_000; // deadline (start + 300s) plus a 30s margin
  const LOST = "Checkpoint result was lost during a control-plane restart.";

  function settlementFixture(overrides: Partial<SandboxProvider> = {}) {
    const takeSnapshot = vi.fn<NonNullable<SandboxProvider["takeSnapshot"]>>(async () => ({
      success: true,
      imageId: "next-image",
    }));
    const stopSandbox = vi.fn(async () => ({ success: true as const }));
    const f = fixture(provider({ takeSnapshot, stopSandbox, ...overrides }), { durable: true });
    return { ...f, takeSnapshot, stopSandbox };
  }

  /** A checkpoint whose provider call never answers this instance, then a restarted instance. */
  async function lostToRestart(f: ReturnType<typeof settlementFixture>) {
    let abandon!: (error: Error) => void;
    f.takeSnapshot.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (abandon = reject))
    );
    const original = f.shutdown.captureCheckpoint(GENERATION, "execution_complete", "continue");
    await vi.waitFor(() => expect(f.takeSnapshot).toHaveBeenCalledOnce());
    const restarted = new SandboxShutdownCoordinator(f.deps as never);
    return { restarted, original, abandon };
  }

  function warned(f: ReturnType<typeof fixture>, decision: string) {
    return f.deps.log.warn.mock.calls.some(
      ([, fields]) => (fields as { decision?: string }).decision === decision
    );
  }

  it("holds an unconfirmed provider outcome until its settle time without failing", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    f.takeSnapshot.mockRejectedValueOnce(new Error("HTTP 502"));

    await expect(
      f.shutdown.captureCheckpoint(GENERATION, "execution_complete", "continue")
    ).resolves.toEqual({ outcome: "unknown" });

    expect(f.store.value).toMatchObject({
      phase: "running",
      checkpointInFlight: true,
      captureOp: { after: "continue", settleAtMs: SETTLE_AT_MS, uncertainAtMs: 100_000 },
    });
    expect(f.store.value?.error).toBeUndefined();
    expect(f.shutdown.admissionDecision()).toBe("held");
    expect(f.deps.alarm.schedule).toHaveBeenLastCalledWith(SETTLE_AT_MS);
    expect(f.deps.messenger.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox_warning" })
    );
    expect(f.shutdown.snapshot()).not.toHaveProperty("captureOp");
  });

  it("releases a live runtime at its settle time with a durable warning", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    f.takeSnapshot.mockRejectedValueOnce(new Error("HTTP 502"));
    await f.shutdown.captureCheckpoint(GENERATION, "execution_complete", "continue");
    const op = f.store.value!.captureOp!;

    f.setNow(SETTLE_AT_MS - 1);
    await expect(f.shutdown.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(f.store.value?.checkpointInFlight).toBe(true);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 5_000;
    await expect(f.shutdown.handleAlarm()).resolves.toBe("continue");

    expect(f.store.value).toMatchObject({ phase: "running", checkpointInFlight: false });
    expect(f.store.value).not.toHaveProperty("captureOp");
    expect(f.sandboxRow.status).toBe("ready");
    expect(f.deps.sandbox.updateSandboxLastActivity).toHaveBeenCalledWith(SETTLE_AT_MS);
    expect(f.deps.events.createEventIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ id: `capture:${op.id}:released`, type: "warning" })
    );
    expect(f.deps.messenger.broadcast).toHaveBeenCalledWith({
      type: "sandbox_event",
      event: expect.objectContaining({ type: "warning" }),
    });
    expect(f.deps.messenger.broadcast).toHaveBeenCalledWith({
      type: "sandbox_status",
      status: "ready",
    });
    expect(warned(f, "release")).toBe(true);
    expect(f.shutdown.admissionDecision()).toBe("ready");

    // The next turn's checkpoint is not skipped as "already snapshotting".
    await expect(
      f.shutdown.captureCheckpoint(GENERATION, "execution_complete", "continue")
    ).resolves.toMatchObject({ outcome: "saved", imageId: "next-image" });
  });

  it("settles a checkpoint whose answer a restart lost, re-arming its alarm on every pass", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted, original, abandon } = await lostToRestart(f);
    expect(f.deps.alarm.schedule).toHaveBeenLastCalledWith(SETTLE_AT_MS);

    // An unrelated earlier alarm consumed the slot; the pass reasserts settlement.
    f.setNow(160_000);
    f.deps.alarm.schedule.mockClear();
    await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(f.deps.alarm.schedule).toHaveBeenCalledWith(SETTLE_AT_MS);
    expect(f.store.value).toMatchObject({ phase: "running", checkpointInFlight: true });

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
    await expect(restarted.handleAlarm()).resolves.toBe("continue");
    expect(f.store.value).toMatchObject({ phase: "running", checkpointInFlight: false });
    expect(f.deps.log.warn).toHaveBeenCalledWith(
      "Unconfirmed sandbox checkpoint released",
      expect.objectContaining({ door: "restart", decision: "release" })
    );

    // The lost attempt's late end changes nothing.
    const released = f.store.value;
    abandon(new Error("instance gone"));
    await original;
    expect(f.store.value).toEqual(released);
  });

  it("defers once for a stale heartbeat, then holds with today's error", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = 100_000;
    await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(f.store.value?.captureOp?.deferredUntilMs).toBe(SETTLE_AT_MS + 90_000);
    expect(f.deps.alarm.schedule).toHaveBeenLastCalledWith(SETTLE_AT_MS + 90_000);
    expect(warned(f, "defer")).toBe(true);

    f.setNow(SETTLE_AT_MS + 90_000);
    await restarted.handleAlarm();
    expect(f.store.value).toMatchObject({
      phase: "unknown",
      error: LOST,
      checkpointInFlight: true,
    });
    expect(f.store.value).not.toHaveProperty("captureOp");
    expect(warned(f, "hold")).toBe(true);
    expect(recoveryActions(restarted)).toEqual(["discard"]);
  });

  it("releases when the heartbeat recovers during the deferral", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);
    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = 100_000;
    await restarted.handleAlarm();

    f.setNow(SETTLE_AT_MS + 90_000);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS + 60_000;
    await expect(restarted.handleAlarm()).resolves.toBe("continue");
    expect(f.store.value).toMatchObject({ phase: "running", checkpointInFlight: false });
  });

  it("holds at once when the sandbox row is dead", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.status = "stopped";
    await restarted.handleAlarm();

    expect(f.store.value).toMatchObject({ phase: "unknown", error: LOST });
  });

  it("keeps today's hold for watchdog checkpoints and destructive providers", async () => {
    const watchdog = settlementFixture();
    await readyWithoutDeadline(watchdog);
    watchdog.takeSnapshot.mockImplementationOnce(() => new Promise(() => {}));
    void watchdog.shutdown.captureCheckpoint(GENERATION, "heartbeat_timeout", "stop_source");
    await vi.waitFor(() => expect(watchdog.takeSnapshot).toHaveBeenCalledOnce());
    const restarted = new SandboxShutdownCoordinator(watchdog.deps as never);
    watchdog.setNow(150_000);
    await restarted.handleAlarm();
    expect(watchdog.store.value).toMatchObject({ phase: "unknown", error: LOST });

    const destructive = settlementFixture({
      capabilities: { ...provider().capabilities, snapshotRequiresShutdown: true },
    });
    await readyWithoutDeadline(destructive);
    destructive.takeSnapshot.mockRejectedValueOnce(new Error("HTTP 502"));
    await destructive.shutdown.captureCheckpoint(GENERATION, "execution_complete", "continue");
    expect(destructive.store.value).toMatchObject({
      phase: "unknown",
      error: "Checkpoint provider outcome is unknown; destructive follow-up remains held.",
      checkpointInFlight: false,
    });
  });

  it("gives a flag written before operations existed one settle time, never extended", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    f.store.write({ ...f.store.value!, checkpointInFlight: true });
    f.sandboxRow.status = "snapshotting";

    f.setNow(200_000);
    const first = new SandboxShutdownCoordinator(f.deps as never);
    await expect(first.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(f.store.value?.captureOp).toMatchObject({ after: "continue", settleAtMs: 530_000 });

    f.setNow(300_000);
    const second = new SandboxShutdownCoordinator(f.deps as never);
    await second.rearmCaptureSettlement();
    expect(f.deps.alarm.schedule).toHaveBeenLastCalledWith(530_000);
    expect(f.store.value?.captureOp?.settleAtMs).toBe(530_000);

    f.setNow(530_000);
    f.sandboxRow.last_heartbeat = 525_000;
    await expect(second.handleAlarm()).resolves.toBe("continue");
    expect(f.store.value?.checkpointInFlight).toBe(false);
  });

  it("fails an old flag on a row that is not snapshotting, as before", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    f.store.write({ ...f.store.value!, checkpointInFlight: true });

    await new SandboxShutdownCoordinator(f.deps as never).handleAlarm();

    expect(f.store.value).toMatchObject({ phase: "unknown", error: LOST });
  });

  it("re-arms at start-up, waking a due operation now", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);

    f.setNow(200_000);
    await restarted.rearmCaptureSettlement();
    expect(f.deps.alarm.schedule).toHaveBeenLastCalledWith(SETTLE_AT_MS);

    f.setNow(SETTLE_AT_MS + 1_000);
    await new SandboxShutdownCoordinator(f.deps as never).rearmCaptureSettlement();
    expect(f.deps.alarm.schedule).toHaveBeenLastCalledWith(SETTLE_AT_MS + 1_000);
  });

  it("lets a due drain claim a settled checkpoint instead of releasing it", async () => {
    const f = settlementFixture();
    await readyFinite(f); // drains at 700_000
    const { restarted } = await lostToRestart(f);

    f.setNow(700_000);
    f.sandboxRow.last_heartbeat = 695_000;
    await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");

    expect(f.store.value).toMatchObject({ phase: "draining", checkpointInFlight: false });
    expect(f.shutdown.admissionDecision()).toBe("held");
    expect(f.deps.sockets.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prepare_preservation" })
    );
  });

  it("claims the lifetime drain when a stale heartbeat would defer past it", async () => {
    const f = settlementFixture();
    await readyFinite(f, 1_060_000); // drains at 460_000, after settling at 430_000
    const { restarted } = await lostToRestart(f);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = 100_000;
    await restarted.handleAlarm();
    // The deferral ends at the drain deadline, not a heartbeat timeout later.
    expect(f.store.value?.captureOp?.deferredUntilMs).toBe(460_000);

    f.setNow(460_000);
    await restarted.handleAlarm();
    expect(f.store.value).toMatchObject({ phase: "draining", checkpointInFlight: false });

    f.setNow(f.store.value!.stopByMs!);
    await restarted.handleAlarm();
    expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
    expect(f.store.value?.phase).toBe("saved");
  });

  it("claims the drain when settlement and drain fall due together with a stale heartbeat", async () => {
    const f = settlementFixture();
    // Admission allows a checkpoint whose settle time equals the drain deadline.
    await readyFinite(f, 1_030_000); // drains at 430_000
    const { restarted } = await lostToRestart(f);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = 100_000;
    await restarted.handleAlarm();

    expect(f.store.value).toMatchObject({ phase: "draining", checkpointInFlight: false });
  });

  it("hands an unsettled checkpoint to an archive without wedging it", async () => {
    const f = settlementFixture();
    await readyFinite(f);
    const { restarted } = await lostToRestart(f);

    f.setNow(150_000);
    await expect(restarted.requestShutdown("archive")).resolves.toBe("owned");
    const stopByMs = f.store.value!.stopByMs!;
    expect(f.store.value).toMatchObject({ phase: "draining", checkpointInFlight: true });
    expect(f.deps.sockets.send).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "prepare_preservation" })
    );

    // Past the stop deadline, the alarm waits for settlement rather than looping on it.
    f.setNow(stopByMs + 10_000);
    f.deps.alarm.schedule.mockClear();
    await restarted.handleAlarm();
    expect(f.deps.alarm.schedule.mock.calls).toEqual([[SETTLE_AT_MS]]);
    expect(f.store.value).toMatchObject({ phase: "draining", checkpointInFlight: true });

    f.setNow(SETTLE_AT_MS);
    await restarted.handleAlarm();
    expect(f.takeSnapshot).toHaveBeenCalledTimes(2);
    // The capture gets a full window from the handoff, not what the wait left.
    expect(f.takeSnapshot.mock.calls[1][0].deadlineAtMs).toBe(SETTLE_AT_MS + 300_000);
    expect(f.store.value).toMatchObject({ phase: "saved", checkpointInFlight: false });
    expect(warned(f, "handoff")).toBe(true);
  });

  it("gives an older flag its operation before an archive claims it", async () => {
    const f = settlementFixture();
    await readyFinite(f);
    f.store.write({ ...f.store.value!, checkpointInFlight: true });
    f.sandboxRow.status = "snapshotting";
    const restarted = new SandboxShutdownCoordinator(f.deps as never);

    await restarted.requestShutdown("archive");
    expect(f.store.value).toMatchObject({
      phase: "draining",
      checkpointInFlight: true,
      captureOp: { after: "continue", settleAtMs: SETTLE_AT_MS },
    });

    f.setNow(f.store.value!.stopByMs!);
    await restarted.handleAlarm();
    expect(f.store.value?.phase).toBe("draining");
  });

  it("holds instead of releasing a runtime that reported a fatal error", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);

    f.setNow(SETTLE_AT_MS - 1_000);
    restarted.recordRuntimeFailure();
    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
    await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");

    expect(f.store.value).toMatchObject({ phase: "unknown", error: LOST });
    expect(restarted.admissionDecision()).toBe("held");
  });

  it("hands a checkpoint that fails after the shutdown claimed it to settlement", async () => {
    const f = settlementFixture();
    await readyFinite(f);
    let fail!: (error: Error) => void;
    f.takeSnapshot.mockImplementationOnce(() => new Promise((_resolve, reject) => (fail = reject)));
    const checkpoint = f.shutdown.captureCheckpoint(GENERATION, "execution_complete", "continue");
    await vi.waitFor(() => expect(f.takeSnapshot).toHaveBeenCalledOnce());

    await f.shutdown.requestShutdown("archive");
    fail(new Error("HTTP 524"));
    await expect(checkpoint).resolves.toEqual({ outcome: "unknown" });

    expect(f.store.value).toMatchObject({
      phase: "draining",
      checkpointInFlight: true,
      captureOp: { uncertainAtMs: 100_000 },
    });
  });

  /** The production scheduler over one alarm slot, delivered as the Durable Object does. */
  function singleSlotAlarm() {
    let pending: number | null = null;
    let inFlight: number | null = null;
    let runtime: number | null = null;
    const deadlines = {
      pending: () => pending,
      earliest: () =>
        [pending, inFlight].reduce<number | null>(
          (min, value) => (value === null ? min : min === null ? value : Math.min(min, value)),
          null
        ),
      cancelled: () => false,
      setPending: (deadline: number) => void (pending = deadline),
      setPendingEarliest: (deadline: number) =>
        void (pending = pending === null ? deadline : Math.min(pending, deadline)),
      activate: () => undefined,
      clear: () => void (pending = inFlight = null),
      beginDelivery: () => {
        if (inFlight === null) [inFlight, pending] = [pending, null];
        return inFlight;
      },
      completeDelivery: () => void (inFlight = null),
    };
    const scheduler = createEarliestAlarmScheduler(
      {
        getAlarm: async () => runtime,
        setAlarm: async (at: number) => void (runtime = at),
        deleteAlarm: async () => void (runtime = null),
      },
      deadlines
    );
    return {
      scheduler,
      pending: () => pending,
      deliver(handle: () => Promise<unknown>) {
        runtime = null; // the platform consumes the alarm it delivers
        return handleAlarmDelivery(
          deadlines,
          async () => void (await handle()),
          () => scheduler.rearmPending()
        );
      },
    };
  }

  it("reasserts settlement after an earlier alarm consumes the single slot, without looping", async () => {
    const f = settlementFixture();
    const slot = singleSlotAlarm();
    (f.deps as { alarm: unknown }).alarm = slot.scheduler;
    await readyWithoutDeadline(f);
    await slot.scheduler.schedule(160_000); // an unrelated earlier check keeps the slot
    const { restarted } = await lostToRestart(f);
    expect(slot.pending()).toBe(160_000);

    f.setNow(160_000);
    await slot.deliver(() => restarted.handleAlarm());
    expect(slot.pending()).toBe(SETTLE_AT_MS);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
    await slot.deliver(() => restarted.handleAlarm());
    expect(f.store.value?.checkpointInFlight).toBe(false);
    expect(slot.pending()).toBeNull();
  });

  it("does not re-arm a past settle time after holding", async () => {
    const f = settlementFixture();
    const slot = singleSlotAlarm();
    (f.deps as { alarm: unknown }).alarm = slot.scheduler;
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);

    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.status = "stopped";
    await slot.deliver(() => restarted.handleAlarm());

    expect(f.store.value?.phase).toBe("unknown");
    expect(slot.pending()).toBeNull();
  });

  it("releases a row that is already ready without announcing a status change", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);
    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.status = "ready";
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
    f.deps.messenger.broadcast.mockClear();

    await expect(restarted.handleAlarm()).resolves.toBe("continue");

    expect(f.store.value?.checkpointInFlight).toBe(false);
    expect(f.deps.messenger.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "sandbox_status" })
    );
  });

  it("does not release when the row or the attempt changed under the release", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);
    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;

    f.deps.sandbox.transitionSandboxStatus.mockReturnValueOnce(false);
    await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(f.store.value).toMatchObject({ phase: "running", checkpointInFlight: true });

    const op = f.store.value!.captureOp!;
    f.deps.session.transaction.mockImplementationOnce((operation: () => unknown) => {
      f.store.write({ ...f.store.value!, captureOp: { ...op, attempt: 2 } });
      return operation();
    });
    await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");
    expect(f.store.value).toMatchObject({ checkpointInFlight: true, captureOp: { attempt: 2 } });
    expect(f.deps.events.createEventIfAbsent).not.toHaveBeenCalled();
    expect(f.deps.sandbox.updateSandboxLastActivity).not.toHaveBeenCalled();
  });

  it("records a fatal report against an older flag by giving it its operation", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    f.store.write({ ...f.store.value!, checkpointInFlight: true });
    f.sandboxRow.status = "snapshotting";
    const restarted = new SandboxShutdownCoordinator(f.deps as never);

    expect(restarted.recordRuntimeFailure()).toBe(true);

    expect(f.store.value?.captureOp).toMatchObject({
      after: "continue",
      runtimeFailedAtMs: 100_000,
    });
  });

  it("commits the warning in the same transaction as the release", async () => {
    const f = settlementFixture();
    await readyWithoutDeadline(f);
    const { restarted } = await lostToRestart(f);
    let inTransaction = false;
    f.deps.session.transaction.mockImplementation((operation: () => unknown) => {
      inTransaction = true;
      try {
        return operation();
      } finally {
        inTransaction = false;
      }
    });
    const persistedInTransaction: boolean[] = [];
    f.deps.events.createEventIfAbsent.mockImplementation(() => {
      persistedInTransaction.push(inTransaction);
      return true;
    });
    f.setNow(SETTLE_AT_MS);
    f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
    await restarted.handleAlarm();

    expect(persistedInTransaction).toEqual([true]);
  });

  describe("composed alarm delivery", () => {
    function composedAlarm(
      f: ReturnType<typeof fixture>,
      shutdown: SandboxShutdownCoordinator,
      redriveIdleQueue: () => Promise<void>,
      lifecycleResult = "no_action"
    ) {
      return createAlarmHandler({
        preserveBeforeWatchdogs: (allowCaptureRetry: boolean) =>
          shutdown.handleAlarm(allowCaptureRetry),
        terminalMessageProjection: { flushPending: vi.fn(async () => undefined) },
        executionStop: {
          recoverStopConfirmationTimeout: vi.fn(async () => undefined),
          resumeAfterSandboxTermination: vi.fn(async () => undefined),
        },
        repository: {
          getProcessingMessageWithStartedAt: vi.fn(() => null),
          getNextPendingMessage: vi.fn(() => null),
        },
        messageQueue: { failStuckProcessingMessage: vi.fn(async () => undefined) },
        lifecycleManager: { handleAlarm: vi.fn(async () => lifecycleResult) },
        redriveIdleQueue,
        log: f.deps.log,
      } as never);
    }

    it("releases once per delivery, then lets the lifecycle wake queued work", async () => {
      const f = settlementFixture();
      await readyWithoutDeadline(f);
      const { restarted } = await lostToRestart(f);
      const redrive = vi.fn(async () => undefined);

      f.setNow(SETTLE_AT_MS);
      f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
      await composedAlarm(f, restarted, redrive).handle();

      expect(f.deps.events.createEventIfAbsent).toHaveBeenCalledOnce();
      expect(redrive).toHaveBeenCalledOnce();
    });

    it("does not wake queued work while held or after the watchdog acted", async () => {
      const f = settlementFixture();
      await readyWithoutDeadline(f);
      const { restarted } = await lostToRestart(f);
      const redrive = vi.fn(async () => undefined);

      await composedAlarm(f, restarted, redrive).handle();
      f.setNow(SETTLE_AT_MS);
      f.sandboxRow.last_heartbeat = SETTLE_AT_MS - 1_000;
      await composedAlarm(f, restarted, redrive, "sandbox_terminated").handle();

      expect(redrive).not.toHaveBeenCalled();
    });
  });
});
