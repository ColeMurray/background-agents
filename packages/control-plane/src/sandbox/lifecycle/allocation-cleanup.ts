import type { Logger } from "../../logger";
import type { AlarmScheduler } from "../../platform-ports";
import type { SandboxRow } from "../../session/types";
import type { SandboxGeneration } from "./ports";
import { boundedProviderStop, type ProviderStopOutcome } from "./provider-stop";

const REJECTED_ALLOCATION_CLEANUP_RETRY_MS = 30_000;

export interface AllocationCleanupStorage {
  getSandbox(): SandboxRow | null;
  updateSandboxModalObjectId(providerObjectId: string | null): void;
}

export interface AllocationCleanupDependencies {
  storage: AllocationCleanupStorage;
  alarmScheduler: Pick<AlarmScheduler, "schedule">;
  canStop: () => boolean;
  /** Confirms only provider retirement; skipped dispatch returns not_stopped. */
  stop: (providerObjectId: string, signal: AbortSignal) => Promise<ProviderStopOutcome>;
  getLogger: () => Pick<Logger, "warn">;
}

export async function rearmRejectedStartupCleanupAlarm(
  deps: Pick<AllocationCleanupDependencies, "storage" | "alarmScheduler">
): Promise<void> {
  const row = deps.storage.getSandbox();
  if (row?.startup_rejected && row.modal_object_id) {
    await deps.alarmScheduler.schedule(Date.now() + REJECTED_ALLOCATION_CLEANUP_RETRY_MS);
  }
}

export async function attemptRejectedStartupCleanup(
  deps: AllocationCleanupDependencies,
  generation: SandboxGeneration,
  providerObjectId: string
): Promise<void> {
  // Persist the next attempt before provider I/O so an eviction cannot lose cleanup.
  await rearmRejectedStartupCleanupAlarm(deps);
  if (!(await destroyLateProviderResult(deps, providerObjectId))) return;
  const row = deps.storage.getSandbox();
  if (
    row?.modal_sandbox_id === generation.sandboxId &&
    row.created_at === generation.createdAt &&
    row.modal_object_id === providerObjectId
  ) {
    deps.storage.updateSandboxModalObjectId(null);
  }
}

export async function destroyLateProviderResult(
  deps: Pick<AllocationCleanupDependencies, "canStop" | "stop" | "getLogger">,
  providerObjectId: string | undefined
): Promise<boolean> {
  if (!providerObjectId || !deps.canStop()) return false;
  try {
    const outcome = await boundedProviderStop(
      (signal) => deps.stop(providerObjectId, signal),
      "Late provider cleanup timed out"
    );
    return outcome === "confirmed";
  } catch (error) {
    deps.getLogger().warn("Failed to destroy superseded provider sandbox", {
      provider_object_id: providerObjectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
