import {
  SESSION_ARCHIVE_HTTP_STATUS,
  sessionArchiveResponseSchema,
  type SessionBatchArchiveResult,
} from "@open-inspect/shared/types/session-archive";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";

const ARCHIVE_CONCURRENCY = 5;
const ARCHIVE_TIMEOUT_MS = 10_000;

/** A bounded batch of independent mutations; callers retry only failed IDs. */
export async function archiveSessionBatch(
  sessionIds: readonly string[],
  runtime: SessionRuntimeClient,
  log: Logger
): Promise<SessionBatchArchiveResult[]> {
  const results = new Array<SessionBatchArchiveResult>(sessionIds.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < sessionIds.length) {
      const index = nextIndex++;
      const sessionId = sessionIds[index];
      let outcome: SessionBatchArchiveResult["outcome"];
      try {
        const response = await runtime.fetch(sessionId, SessionInternalPaths.archive, {
          method: "POST",
          signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
        });
        if (response.status === 404) {
          outcome = "not_found";
        } else {
          if (response.status !== 200 && response.status !== 409) {
            throw new Error(`Session archive returned HTTP ${response.status}`);
          }
          const parsed = sessionArchiveResponseSchema.parse(await response.json());
          if (response.status !== SESSION_ARCHIVE_HTTP_STATUS[parsed.outcome]) {
            throw new Error("Session archive returned an inconsistent outcome");
          }
          outcome = parsed.outcome;
        }
      } catch (error) {
        log.warn("Session batch archive target failed", {
          event: "session.batch_archive_target_failed",
          session_id: sessionId,
          error,
        });
        outcome = "failed";
      }
      results[index] = { sessionId, outcome };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, sessionIds.length) }, worker)
  );
  return results;
}
