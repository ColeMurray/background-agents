import type { OpenComputerRestClient } from "../../src/sandbox/opencomputer-rest-client";
import type { OpenComputerSandboxProvider } from "../../src/sandbox/providers/opencomputer-provider";

const CHECKPOINT_CLEANUP_TIMEOUT_MS = 300_000;
const CHECKPOINT_POLL_INTERVAL_MS = 1_000;
const SANDBOX_CLEANUP_TIMEOUT_MS = 15_000;

/** These source sandboxes belong exclusively to the canary, including unknown captures. */
export async function cleanupOpenComputerCanary(
  client: Pick<OpenComputerRestClient, "listCheckpoints" | "deleteCheckpoint">,
  provider: Pick<OpenComputerSandboxProvider, "stopSandbox">,
  ids: string[],
  sessionId: string
): Promise<void> {
  const deadlineAtMs = Date.now() + CHECKPOINT_CLEANUP_TIMEOUT_MS;
  const signal = AbortSignal.timeout(CHECKPOINT_CLEANUP_TIMEOUT_MS);
  const results = await Promise.allSettled(
    ids.map(async (id) => {
      let checkpoints = await client.listCheckpoints(id, signal);
      while (checkpoints.some(({ status }) => status === "processing" || status === "pending")) {
        if (Date.now() >= deadlineAtMs)
          throw new Error(`Canary checkpoint upload still processing for ${id}`);
        await new Promise((resolve) => setTimeout(resolve, CHECKPOINT_POLL_INTERVAL_MS));
        checkpoints = await client.listCheckpoints(id, signal);
      }
      // Waiting for completion prevents deletion racing a background upload.
      const deletions = await Promise.allSettled(
        checkpoints.map(({ id: checkpointId }) => client.deleteCheckpoint(id, checkpointId, signal))
      );
      const errors = deletions.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length)
        throw new AggregateError(errors, `Canary checkpoint deletion failed for ${id}`);
    })
  );
  // Always attempt sandbox destruction even if discovery, polling or deletion failed.
  results.push(
    ...(await Promise.allSettled(
      ids.map(async (providerObjectId) => {
        const result = await provider.stopSandbox({
          sessionId,
          providerObjectId,
          reason: "canary_cleanup",
          intent: "destroy",
          deadlineAtMs: Date.now() + SANDBOX_CLEANUP_TIMEOUT_MS,
        });
        if (!result.success) throw new Error(result.error ?? "Canary sandbox cleanup failed");
      })
    ))
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, "OpenComputer canary cleanup failed");
}
