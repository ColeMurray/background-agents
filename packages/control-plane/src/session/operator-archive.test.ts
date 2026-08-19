import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SessionRuntimeClient } from "./runtime-client";
import {
  archiveOperatorSessionPage,
  authorizeOperatorUserId,
  encodeOperatorArchiveCursor,
  OPERATOR_ARCHIVE_PAGE_SIZE,
  parseOperatorArchiveCursor,
  type OperatorArchiveIndex,
} from "./operator-archive";

const OPERATOR_USER_ID = "0123456789abcdef0123456789abcdef";
const VERIFIED_OPERATOR_USER_ID = authorizeOperatorUserId(OPERATOR_USER_ID, OPERATOR_USER_ID)!;

function createLog(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe("operator archive cursor", () => {
  it("round-trips a stable keyset position", () => {
    const cursor = {
      cutoffCreatedAt: 500,
      resume: { createdAt: 200, id: "session:/one" },
    };
    expect(parseOperatorArchiveCursor(encodeOperatorArchiveCursor(cursor))).toEqual({
      ok: true,
      cursor,
    });
  });

  it.each(["", "bad", "1:2:", "1:2:%E0%A4%A", "1:2:three:four", "1:2.5:id", "1:2:id"])(
    "rejects malformed cursor %j",
    (cursor) => {
      expect(parseOperatorArchiveCursor(cursor)).toEqual({
        ok: false,
        error: "Invalid cursor",
      });
    }
  );
});

describe("archiveOperatorSessionPage", () => {
  it("aggregates authoritative DO outcomes and advances the keyset", async () => {
    const candidates = [
      { id: "archived", createdAt: 1, indexStatus: "completed" as const },
      { id: "already", createdAt: 2, indexStatus: "archived" as const },
      { id: "cancelled", createdAt: 3, indexStatus: "cancelled" as const },
      { id: "queued", createdAt: 4, indexStatus: "active" as const },
      { id: "missing", createdAt: 5, indexStatus: "archived" as const },
    ];
    const index: OperatorArchiveIndex = {
      listOperatorArchiveCandidates: vi.fn().mockResolvedValue({ candidates, hasMore: true }),
    };
    const outcomeById = {
      archived: ["archived", "archived"],
      already: ["already_archived", "archived"],
      cancelled: ["skipped_cancelled", "cancelled"],
      queued: ["skipped_queued_work", "active"],
    } as const;
    const runtime = {
      fetch: vi.fn(async (sessionId: string) => {
        if (sessionId === "missing") {
          return Response.json({ error: "Session not found" }, { status: 404 });
        }
        const [outcome, status] = outcomeById[sessionId as keyof typeof outcomeById];
        return Response.json(
          { outcome, status },
          { status: outcome.startsWith("skipped_") ? 409 : 200 }
        );
      }),
    } as unknown as SessionRuntimeClient;

    const result = await archiveOperatorSessionPage({
      index,
      runtime,
      log: createLog(),
      operatorUserId: VERIFIED_OPERATOR_USER_ID,
      cursor: null,
      now: 10,
    });

    expect(result).toEqual({
      archivedIds: ["archived"],
      alreadyArchivedIds: ["already"],
      missingArchivedIds: ["missing"],
      skippedCancelledIds: ["cancelled"],
      skippedQueuedWorkIds: ["queued"],
      failed: [],
      hasMore: true,
      nextCursor: "10:5:missing",
    });
    expect(index.listOperatorArchiveCandidates).toHaveBeenCalledWith({
      cutoffCreatedAt: 10,
      cursor: null,
      limit: OPERATOR_ARCHIVE_PAGE_SIZE,
    });
  });

  it("replays the same page when any DO request fails", async () => {
    const cursor = {
      cutoffCreatedAt: 50,
      resume: { createdAt: 20, id: "previous" },
    };
    const index: OperatorArchiveIndex = {
      listOperatorArchiveCandidates: vi.fn().mockResolvedValue({
        candidates: [
          { id: "ok", createdAt: 21, indexStatus: "completed" },
          { id: "failed", createdAt: 22, indexStatus: "completed" },
        ],
        hasMore: true,
      }),
    };
    const runtime = {
      fetch: vi.fn(async (sessionId: string) => {
        if (sessionId === "failed") throw new Error("network failed");
        return Response.json({ outcome: "archived", status: "archived" });
      }),
    } as unknown as SessionRuntimeClient;

    const result = await archiveOperatorSessionPage({
      index,
      runtime,
      log: createLog(),
      operatorUserId: VERIFIED_OPERATOR_USER_ID,
      cursor,
      now: 100,
    });

    expect(result.archivedIds).toEqual(["ok"]);
    expect(result.failed).toEqual([{ sessionId: "failed", error: "network failed" }]);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(encodeOperatorArchiveCursor(cursor));
  });

  it("preserves the first-page cutoff when its request must be retried", async () => {
    const index: OperatorArchiveIndex = {
      listOperatorArchiveCandidates: vi.fn().mockResolvedValue({
        candidates: [{ id: "failed", createdAt: 10, indexStatus: "completed" }],
        hasMore: false,
      }),
    };
    const runtime = {
      fetch: vi.fn().mockRejectedValue(new Error("timeout")),
    } as unknown as SessionRuntimeClient;

    const result = await archiveOperatorSessionPage({
      index,
      runtime,
      log: createLog(),
      operatorUserId: VERIFIED_OPERATOR_USER_ID,
      cursor: null,
      now: 100,
    });

    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe("100:0:");
    expect(parseOperatorArchiveCursor(result.nextCursor)).toEqual({
      ok: true,
      cursor: { cutoffCreatedAt: 100, resume: null },
    });
  });
});
