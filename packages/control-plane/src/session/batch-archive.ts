import {
  SESSION_ARCHIVE_HTTP_STATUS,
  sessionArchiveResponseSchema,
  type SessionBatchArchiveResult,
} from "@open-inspect/shared/types/session-archive";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";

const ARCHIVE_CONCURRENCY = 5;
// One deadline for all waves, leaving response overhead below the web proxy's deadline.
const ARCHIVE_BATCH_TIMEOUT_MS = 10_000;

async function archiveTarget(
  sessionId: string,
  runtime: SessionRuntimeClient,
  signal: AbortSignal
): Promise<SessionBatchArchiveResult["outcome"]> {
  const response = await runtime.fetch(sessionId, SessionInternalPaths.archive, {
    method: "POST",
    signal,
  });
  if (response.status === 404) return "not_found";
  if (response.status !== 200 && response.status !== 409) {
    throw new Error(`Session archive returned HTTP ${response.status}`);
  }
  const parsed = sessionArchiveResponseSchema.parse(await response.json());
  if (response.status !== SESSION_ARCHIVE_HTTP_STATUS[parsed.outcome]) {
    throw new Error("Session archive returned an inconsistent outcome");
  }
  return parsed.outcome;
}

/** A bounded batch of independent mutations; callers retry only failed IDs. */
export async function archiveSessionBatch(
  sessionIds: readonly string[],
  runtime: SessionRuntimeClient,
  log: Logger
): Promise<SessionBatchArchiveResult[]> {
  const results = new Array<SessionBatchArchiveResult>(sessionIds.length);
  const signal = AbortSignal.timeout(ARCHIVE_BATCH_TIMEOUT_MS);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < sessionIds.length) {
      const index = nextIndex++;
      const sessionId = sessionIds[index];
      let outcome: SessionBatchArchiveResult["outcome"];
      let onAbort: (() => void) | undefined;
      try {
        signal.throwIfAborted();
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        // Some runtime transports cannot cancel dispatched mutations. Bound the
        // response wait (including its body) independently of transport cancellation.
        outcome = await Promise.race([aborted, archiveTarget(sessionId, runtime, signal)]);
      } catch (error) {
        log.warn("Session batch archive target failed", {
          event: "session.batch_archive_target_failed",
          session_id: sessionId,
          error,
        });
        outcome = "failed";
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
      results[index] = { sessionId, outcome };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, sessionIds.length) }, worker)
  );
  return results;
}
