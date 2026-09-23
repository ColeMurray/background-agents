import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxProvider } from "../sandbox/provider";
import { SandboxShutdownCoordinator } from "./sandbox-shutdown";
import type { ShutdownRecord, ShutdownStore } from "./sandbox-shutdown-repository";

const GENERATION = { sandboxId: "sandbox-1", createdAt: 1_000 };

class MemoryStore implements ShutdownStore {
  value: ShutdownRecord | null = null;
  read() {
    return this.value;
  }
  write(record: ShutdownRecord) {
    this.value = structuredClone(record);
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

function fixture(providerValue = provider()) {
  let now = 100_000;
  const store = new MemoryStore();
  const calls: string[] = [];
  const backgroundTasks: Array<() => Promise<void>> = [];
  const socket = {};
  const sandboxRow = {
    modal_sandbox_id: GENERATION.sandboxId,
    modal_object_id: "provider-object-1" as string | null,
    created_at: GENERATION.createdAt,
    runtime_version: "runtime-1",
    status: "ready",
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
    alarm: { schedule: vi.fn(async () => undefined) },
    background: {
      submit: vi.fn((task: () => Promise<void>) => backgroundTasks.push(task)),
    },
    onLifecycleChange: vi.fn(async () => undefined),
    reconcileStatusFromMessages: vi.fn(async () => undefined),
    retireAccess: vi.fn(() => calls.push("access-retired")),
    now: () => now,
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
    const checkpoint = f.shutdown.captureCheckpoint(GENERATION, "checkpoint");

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

    await expect(f.shutdown.captureCheckpoint(GENERATION, "checkpoint")).resolves.toEqual({
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

    await expect(f.shutdown.captureCheckpoint(GENERATION, "checkpoint")).resolves.toEqual({
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
      const run = f.shutdown.captureCheckpoint(GENERATION, "checkpoint");

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
    const oldCapture = f.shutdown.captureCheckpoint(GENERATION, "checkpoint");
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
        "sandbox_lifetime_expiring",
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
      "sandbox_lifetime_expiring",
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
      error: expect.stringContaining("provider result is unknown"),
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
        error: expect.stringContaining("deadline exceeded"),
      });
      expect(stopSandbox).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries only a confirmed pre-capture failure with a new operation", async () => {
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => ({
          success: true,
          imageId: "snapshot-1",
          sourceStopped: true,
        })),
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    const firstOperation = f.store.value!.operationId;
    f.shutdown.prepared({
      ...preparedEvent(f.store.value!),
      executionStopped: false,
      error: "execution_stop_unconfirmed",
    });
    expect(f.store.value?.phase).toBe("failed");
    f.deps.sockets.send.mockClear();

    await f.shutdown.recover("retry");

    expect(f.store.value).toMatchObject({ phase: "draining", error: undefined });
    expect(f.store.value?.operationId).not.toBe(firstOperation);
    expect(f.deps.sockets.send).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "prepare_preservation",
        operationId: f.store.value?.operationId,
      })
    );
  });

  it("refuses to repeat capture after an unknown provider result", async () => {
    const f = fixture();
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.store.write({ ...f.store.value!, phase: "unknown", error: "capture outcome unknown" });
    f.deps.provider.takeSnapshot = vi.fn();

    await expect(f.shutdown.recover("retry")).rejects.toThrow(
      "unknown provider result cannot be retried"
    );
    expect(f.deps.provider.takeSnapshot).not.toHaveBeenCalled();
    expect(f.store.value?.phase).toBe("unknown");
  });

  it("projects exactly the recovery actions accepted for the current provider and phase", async () => {
    const f = fixture(
      provider({
        takeSnapshot: vi.fn(async () => ({
          success: true,
          imageId: "snapshot-1",
          sourceStopped: true,
        })),
        stopSandbox: vi.fn(async () => ({ success: true })),
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.shutdown.prepared({
      ...preparedEvent(f.store.value!),
      executionStopped: false,
      error: "execution_stop_unconfirmed",
    });
    expect(f.shutdown.snapshot()?.availableRecoveryActions).toEqual(["retry"]);

    const receipt = {
      kind: "snapshot" as const,
      artifactId: "last-good-image",
      provider: "modal",
      savedAtMs: 50_000,
      runtimeVersion: "runtime-1",
    };
    f.store.write({ ...f.store.value!, phase: "unknown", receipt });
    expect(f.shutdown.snapshot()?.availableRecoveryActions).toEqual(["restore_saved"]);

    f.store.write({ ...f.store.value!, receipt: undefined });
    expect(f.shutdown.snapshot()?.availableRecoveryActions).toEqual([]);

    f.store.write({ ...f.store.value!, receipt, provider: "other" });
    expect(f.shutdown.snapshot()?.availableRecoveryActions).toEqual([]);

    f.store.write({
      ...f.store.value!,
      provider: "modal",
      receipt: { ...receipt, provider: "other" },
    });
    expect(f.shutdown.snapshot()?.availableRecoveryActions).toEqual([]);
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

    expect(f.shutdown.snapshot()?.availableRecoveryActions).toEqual([]);
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
      name: "legacy lifecycle retry",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.store.write({ ...f.store.value!, lifecyclePolicy: "legacy" });
      },
    },
    {
      name: "missing runtime protocol",
      action: "retry" as const,
      mutate: (f: ReturnType<typeof fixture>) => {
        f.store.write({ ...f.store.value!, protocolVersion: undefined });
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
        takeSnapshot: vi.fn(async () => ({
          success: true,
          imageId: "snapshot-1",
          sourceStopped: true,
        })),
      })
    );
    await readyFinite(f);
    await f.shutdown.requestShutdown("sandbox_lifetime_expiring");
    f.shutdown.prepared({
      ...preparedEvent(f.store.value!),
      executionStopped: false,
      error: "execution_stop_unconfirmed",
    });
    mutate(f);
    const before = structuredClone(f.store.value);

    expect(f.shutdown.snapshot()?.availableRecoveryActions).not.toContain(action);
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
    expect(interrupted.snapshot()?.availableRecoveryActions).toEqual(["restore_saved"]);
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
