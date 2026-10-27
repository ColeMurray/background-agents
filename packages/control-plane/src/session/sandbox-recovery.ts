import type { SandboxAlarmResult } from "../sandbox/lifecycle/ports";
import type { ExecutionStopCoordinator } from "./execution-stop-coordinator";
import type { SessionMessageQueue } from "./message-queue";

export interface SandboxRecoveryDeps {
  messageQueue: Pick<SessionMessageQueue, "failPendingMessage">;
  executionStop: Pick<ExecutionStopCoordinator, "resumeAfterSandboxTermination">;
}

/**
 * Apply a lifecycle recovery to the queue. A terminated generation is
 * replaced. An abandoned boot fails `bootPrompt`, the prompt it was for, with
 * the same words the user sees, and nothing re-drives it onto a fresh
 * sandbox. A lost heartbeat whose save holds the source wakes nothing: the
 * hold parks the queue until recovery, and a pending stop confirmation times
 * out on its own.
 */
export async function applySandboxRecovery(
  deps: SandboxRecoveryDeps,
  bootPrompt: { id: string } | null,
  result: SandboxAlarmResult
): Promise<void> {
  if (result === "sandbox_terminated") {
    await deps.executionStop.resumeAfterSandboxTermination();
  }
  if (bootPrompt && typeof result === "object" && result.kind !== "heartbeat_lost") {
    await deps.messageQueue.failPendingMessage(bootPrompt.id, result.reason);
  }
}
