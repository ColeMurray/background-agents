import { sessionStatusSchema } from "@open-inspect/shared/types/sessions";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import { z } from "zod";
import type {
  OperatorArchiveCandidateCursor,
  OperatorArchiveCandidatePage,
} from "../db/session-index";
import type { Logger } from "../logger";
import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";

export const OPERATOR_ARCHIVE_PAGE_SIZE = 25;
export const OPERATOR_ARCHIVE_CONCURRENCY = 5;
export const OPERATOR_ARCHIVE_TIMEOUT_MS = 10_000;

declare const verifiedOperatorUserId: unique symbol;
export type VerifiedOperatorUserId = string & {
  readonly [verifiedOperatorUserId]: true;
};

export function authorizeOperatorUserId(
  userId: string,
  rawAllowlist: string | undefined
): VerifiedOperatorUserId | null {
  const normalized = rawAllowlist?.trim() ?? "";
  if (normalized === "") return null;

  const userIds = normalized.split(",").map((value) => value.trim());
  if (userIds.some((candidate) => !isCanonicalUserId(candidate))) {
    throw new Error("OPERATOR_USER_IDS contains a malformed canonical user ID");
  }
  return new Set(userIds).has(userId) ? (userId as VerifiedOperatorUserId) : null;
}

export const operatorArchiveRequestSchema = z
  .object({
    operatorUserId: z.string().refine(isCanonicalUserId),
  })
  .strict();

export const operatorArchiveOutcomeSchema = z.enum([
  "archived",
  "already_archived",
  "skipped_cancelled",
  "skipped_queued_work",
]);

export type OperatorArchiveOutcome = z.infer<typeof operatorArchiveOutcomeSchema>;
type OperatorArchiveCandidateOutcome = OperatorArchiveOutcome | "missing";

export const OPERATOR_ARCHIVE_HTTP_STATUS = {
  archived: 200,
  already_archived: 200,
  skipped_cancelled: 409,
  skipped_queued_work: 409,
} as const satisfies Record<OperatorArchiveOutcome, 200 | 409>;

export const operatorArchiveResponseSchema = z
  .object({
    outcome: operatorArchiveOutcomeSchema,
    status: sessionStatusSchema,
  })
  .strict();

export interface OperatorArchiveCursor {
  cutoffCreatedAt: number;
  resume: OperatorArchiveCandidateCursor | null;
}

export interface OperatorArchiveIndex {
  listOperatorArchiveCandidates(options: {
    cutoffCreatedAt: number;
    cursor: OperatorArchiveCandidateCursor | null;
    limit: number;
  }): Promise<OperatorArchiveCandidatePage>;
}

export interface OperatorArchiveBatchResult {
  archivedIds: string[];
  alreadyArchivedIds: string[];
  missingArchivedIds: string[];
  skippedCancelledIds: string[];
  skippedQueuedWorkIds: string[];
  failed: Array<{ sessionId: string; error: string }>;
  hasMore: boolean;
  nextCursor: string | null;
}

export function encodeOperatorArchiveCursor(cursor: OperatorArchiveCursor): string {
  const resume = cursor.resume;
  return resume
    ? `${cursor.cutoffCreatedAt}:${resume.createdAt}:${encodeURIComponent(resume.id)}`
    : `${cursor.cutoffCreatedAt}:0:`;
}

export function parseOperatorArchiveCursor(
  raw: string | null | undefined
): { ok: true; cursor: OperatorArchiveCursor | null } | { ok: false; error: "Invalid cursor" } {
  if (raw === null || raw === undefined) return { ok: true, cursor: null };

  const parts = raw.split(":");
  if (parts.length !== 3) return { ok: false, error: "Invalid cursor" };
  const cutoffCreatedAt = Number(parts[0]);
  const createdAt = Number(parts[1]);
  if (
    !Number.isSafeInteger(cutoffCreatedAt) ||
    cutoffCreatedAt < 0 ||
    !Number.isSafeInteger(createdAt) ||
    createdAt < 0 ||
    createdAt > cutoffCreatedAt
  ) {
    return { ok: false, error: "Invalid cursor" };
  }

  try {
    const id = decodeURIComponent(parts[2]);
    const resume = createdAt === 0 && id === "" ? null : { createdAt, id };
    return resume === null || id
      ? { ok: true, cursor: { cutoffCreatedAt, resume } }
      : { ok: false, error: "Invalid cursor" };
  } catch {
    return { ok: false, error: "Invalid cursor" };
  }
}

async function archiveCandidate(
  runtime: SessionRuntimeClient,
  sessionId: string,
  operatorUserId: VerifiedOperatorUserId
): Promise<OperatorArchiveCandidateOutcome> {
  const response = await runtime.fetch(sessionId, SessionInternalPaths.operatorArchive, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operatorUserId }),
    signal: AbortSignal.timeout(OPERATOR_ARCHIVE_TIMEOUT_MS),
  });
  if (response.status === 404) return "missing";
  if (response.status !== 200 && response.status !== 409) {
    throw new Error(`Operator archive failed with status ${response.status}`);
  }

  const parsed = operatorArchiveResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Operator archive returned an unrecognized outcome");
  }
  return parsed.data.outcome;
}

async function mapSettledBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export async function archiveOperatorSessionPage(options: {
  index: OperatorArchiveIndex;
  runtime: SessionRuntimeClient;
  log: Logger;
  operatorUserId: VerifiedOperatorUserId;
  cursor: OperatorArchiveCursor | null;
  now: number;
}): Promise<OperatorArchiveBatchResult> {
  const { index, runtime, log, operatorUserId, cursor, now } = options;
  const cutoffCreatedAt = cursor?.cutoffCreatedAt ?? now;
  const page = await index.listOperatorArchiveCandidates({
    cutoffCreatedAt,
    cursor: cursor?.resume ?? null,
    limit: OPERATOR_ARCHIVE_PAGE_SIZE,
  });
  const settled = await mapSettledBounded(
    page.candidates,
    OPERATOR_ARCHIVE_CONCURRENCY,
    (candidate) => archiveCandidate(runtime, candidate.id, operatorUserId)
  );
  const result: OperatorArchiveBatchResult = {
    archivedIds: [],
    alreadyArchivedIds: [],
    missingArchivedIds: [],
    skippedCancelledIds: [],
    skippedQueuedWorkIds: [],
    failed: [],
    hasMore: false,
    nextCursor: null,
  };

  for (const [candidateIndex, outcome] of settled.entries()) {
    const candidate = page.candidates[candidateIndex];
    const sessionId = candidate.id;
    if (outcome.status === "rejected") {
      result.failed.push({
        sessionId,
        error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
      });
      continue;
    }

    switch (outcome.value) {
      case "archived":
        result.archivedIds.push(sessionId);
        break;
      case "already_archived":
        result.alreadyArchivedIds.push(sessionId);
        break;
      case "skipped_cancelled":
        result.skippedCancelledIds.push(sessionId);
        break;
      case "skipped_queued_work":
        result.skippedQueuedWorkIds.push(sessionId);
        break;
      case "missing":
        if (candidate.indexStatus === "archived") {
          result.missingArchivedIds.push(sessionId);
        } else {
          result.failed.push({
            sessionId,
            error: `Session runtime missing for ${candidate.indexStatus} index row`,
          });
        }
        break;
      default: {
        const exhaustive: never = outcome.value;
        throw new Error(`Unhandled operator archive outcome: ${exhaustive}`);
      }
    }
  }

  if (result.failed.length > 0) {
    result.hasMore = true;
    result.nextCursor = encodeOperatorArchiveCursor(cursor ?? { cutoffCreatedAt, resume: null });
  } else if (page.hasMore) {
    const last = page.candidates.at(-1);
    if (!last) throw new Error("Operator archive page reported more rows without a cursor");
    result.hasMore = true;
    result.nextCursor = encodeOperatorArchiveCursor({ cutoffCreatedAt, resume: last });
  }

  log.info("Operator session archive page completed", {
    event: "operator.session_archive_page",
    operator_user_id: operatorUserId,
    archived_ids: result.archivedIds,
    already_archived_ids: result.alreadyArchivedIds,
    missing_archived_ids: result.missingArchivedIds,
    skipped_cancelled_ids: result.skippedCancelledIds,
    skipped_queued_work_ids: result.skippedQueuedWorkIds,
    failed_ids: result.failed.map(({ sessionId }) => sessionId),
    has_more: result.hasMore,
    next_cursor: result.nextCursor,
  });

  return result;
}
