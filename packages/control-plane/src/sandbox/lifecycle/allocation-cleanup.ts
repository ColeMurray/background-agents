import type { Logger } from "../../logger";
import type { AlarmScheduler } from "../../platform-ports";
import type { SandboxRow } from "../../session/types";
import type { SandboxGeneration } from "./ports";

export const PROVIDER_REPLACEMENT_STOP_TIMEOUT_MS = 10_000;
const REJECTED_ALLOCATION_CLEANUP_RETRY_MS = 30_000;

export interface AllocationCleanupStorage {
  getSandbox(): SandboxRow | null;
  updateSandboxModalObjectId(providerObjectId: string | null): void;
}

export interface AllocationCleanupDependencies {
  storage: AllocationCleanupStorage;
  alarmScheduler: Pick<AlarmScheduler, "schedule">;
  canStop: () => boolean;
  /** Stops only the supplied handle, preserving the caller's stop arguments. */
  stop: (providerObjectId: string, signal: AbortSignal) => Promise<void>;
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
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error("Late provider cleanup timed out"));
      }, PROVIDER_REPLACEMENT_STOP_TIMEOUT_MS);
    });
    await Promise.race([deps.stop(providerObjectId, controller.signal), stopTimeoutPromise]);
    return true;
  } catch (error) {
    deps.getLogger().warn("Failed to destroy superseded provider sandbox", {
      provider_object_id: providerObjectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
