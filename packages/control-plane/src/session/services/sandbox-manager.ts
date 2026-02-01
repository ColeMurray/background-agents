/**
 * SandboxManager implementation.
 */

import type { SandboxManager } from "./types";
import type { SandboxRepository } from "../repository/types";

interface SandboxManagerDependencies {
  sandboxRepo: SandboxRepository;
  modalSpawn: (options: { snapshotId?: string }) => Promise<{
    sandbox_id: string;
    object_id: string;
  }>;
  modalSnapshot: (options: { reason: string }) => Promise<{ snapshot_id: string }>;
}

// Constants
const CIRCUIT_BREAKER_THRESHOLD = 3; // failures
const CIRCUIT_BREAKER_WINDOW = 5 * 60 * 1000; // 5 minutes
const INACTIVITY_TIMEOUT = 30 * 60 * 1000; // 30 minutes

/**
 * Create a SandboxManager instance.
 */
export function createSandboxManager(deps: SandboxManagerDependencies): SandboxManager {
  const { sandboxRepo, modalSpawn, modalSnapshot } = deps;

  return {
    async spawnSandbox(): Promise<void> {
      try {
        // Call Modal API to spawn sandbox
        const result = await modalSpawn({});

        // Update repository with spawn result
        sandboxRepo.update({
          modalSandboxId: result.sandbox_id,
          status: "spawning",
        });

        // Reset failure count on successful spawn
        sandboxRepo.resetSpawnFailureCount();
      } catch (error) {
        // Increment failure count
        sandboxRepo.incrementSpawnFailureCount(Date.now());

        // Update status to failed
        sandboxRepo.updateStatus("failed");

        throw error;
      }
    },

    async restoreFromSnapshot(snapshotId: string): Promise<void> {
      try {
        // Call Modal API to spawn sandbox with snapshot
        const result = await modalSpawn({ snapshotId });

        // Update repository with spawn result
        sandboxRepo.update({
          modalSandboxId: result.sandbox_id,
          status: "spawning",
        });

        // Reset failure count on successful spawn
        sandboxRepo.resetSpawnFailureCount();
      } catch (error) {
        // Increment failure count
        sandboxRepo.incrementSpawnFailureCount(Date.now());

        // Update status to failed
        sandboxRepo.updateStatus("failed");

        throw error;
      }
    },

    canSpawnSandbox(): boolean {
      const failureInfo = sandboxRepo.getSpawnFailureInfo();

      // Circuit breaker: block if too many recent failures
      if (failureInfo.count >= CIRCUIT_BREAKER_THRESHOLD) {
        const timeSinceLastFailure = failureInfo.lastFailure
          ? Date.now() - failureInfo.lastFailure
          : Infinity;

        if (timeSinceLastFailure < CIRCUIT_BREAKER_WINDOW) {
          return false;
        }
      }

      return true;
    },

    async triggerSnapshot(reason: string): Promise<void> {
      const result = await modalSnapshot({ reason });

      // Update sandbox repository with new snapshot ID
      sandboxRepo.updateSnapshot(result.snapshot_id);
    },

    isInactive(): boolean {
      const sandbox = sandboxRepo.get();
      if (!sandbox?.last_activity) {
        return false;
      }

      const timeSinceActivity = Date.now() - sandbox.last_activity;
      return timeSinceActivity > INACTIVITY_TIMEOUT;
    },

    updateStatus(status: string): void {
      sandboxRepo.updateStatus(status);
    },

    updateHeartbeat(): void {
      sandboxRepo.updateLastHeartbeat(Date.now());
    },

    updateActivity(): void {
      sandboxRepo.updateLastActivity(Date.now());
    },
  };
}
