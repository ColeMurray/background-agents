/**
 * Lifecycle vocabulary shared by everything that drives Daytona resources:
 * the cadence a flow re-reads a resource at, the snapshot read that reports
 * absence as a value rather than an error, and the classification a Daytona
 * failure carries into the control plane.
 */

import {
  DaytonaApiError,
  DaytonaCancelledError,
  DaytonaNotFoundError,
  type DaytonaRestClient,
  type DaytonaSnapshotResponse,
} from "./daytona-rest-client";
import { SandboxProviderError } from "./provider";

/** How often a flow waiting on a Daytona resource re-reads its state. */
export const LIFECYCLE_POLL_INTERVAL_MS = 2_000;

/** The snapshot under `nameOrId`, or null when the provider has none. */
export async function getDaytonaSnapshot(
  client: DaytonaRestClient,
  nameOrId: string,
  signal?: AbortSignal
): Promise<DaytonaSnapshotResponse | null> {
  try {
    return await client.getSnapshot(nameOrId, signal);
  } catch (error) {
    if (error instanceof DaytonaNotFoundError) return null;
    throw error;
  }
}

/** The control-plane classification of a failed Daytona call. */
export function classifyDaytonaError(message: string, error: unknown): SandboxProviderError {
  if (error instanceof DaytonaCancelledError) {
    // The budget ran out, not the provider: the obligation stays pending.
    return new SandboxProviderError(`${message}: ${error.message}`, "transient", error);
  }
  if (error instanceof DaytonaApiError) {
    return SandboxProviderError.fromFetchError(`${message}: ${error.message}`, error, error.status);
  }
  return SandboxProviderError.fromFetchError(message, error);
}
