/**
 * Shared fixture for the shutdown coordinator's test files.
 *
 * Extracted so each behaviour — the ordered protocol, adoption of a generation
 * the coordinator never started — gets its own focused file instead of one
 * test file growing alongside the coordinator.
 */
import { vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { SandboxProvider } from "../sandbox/provider";
import { SandboxShutdownCoordinator } from "./sandbox-shutdown";
import type { ShutdownRecord, ShutdownStore } from "./sandbox-shutdown-repository";

export const GENERATION = { sandboxId: "sandbox-1", createdAt: 1_000 };

export class MemoryStore implements ShutdownStore {
  value: ShutdownRecord | null = null;
  read() {
    return this.value;
  }
  write(record: ShutdownRecord) {
    this.value = structuredClone(record);
  }
}

export function provider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
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

export function fixture(providerValue = provider()) {
  let now = 100_000;
  const store = new MemoryStore();
  const calls: string[] = [];
  const backgroundTasks: Array<() => Promise<void>> = [];
  const socket = {};
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
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
    log,
  };
  const shutdown = new SandboxShutdownCoordinator(deps as never);
  return {
    shutdown,
    deps,
    store,
    calls,
    log,
    backgroundTasks,
    sandboxRow,
    setNow(value: number) {
      now = value;
    },
  };
}

export async function readyFinite(f: ReturnType<typeof fixture>, expiresAtMs = 1_300_000) {
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

export async function readyWithoutDeadline(f: ReturnType<typeof fixture>) {
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

export function reserveGeneration(
  f: ReturnType<typeof fixture>,
  generation: typeof GENERATION,
  policy: "confirmed" | "legacy"
) {
  f.shutdown.reserveStartup(generation.createdAt, policy, () => {
    f.sandboxRow.modal_sandbox_id = generation.sandboxId;
    f.sandboxRow.created_at = generation.createdAt;
  });
}

export function preparedEvent(
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
