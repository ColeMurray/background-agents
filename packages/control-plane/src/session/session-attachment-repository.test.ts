import { beforeEach, describe, expect, it } from "vitest";
import {
  AttachmentClaimConflictError,
  SessionAttachmentRepository,
} from "./session-attachment-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const rowsByQuery = new Map<string, unknown[]>();
  let rowsWritten = 0;

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      let consumed = false;
      return {
        toArray: () => {
          consumed = true;
          return rowsByQuery.get(query) ?? [];
        },
        one: () => null,
        get rowsWritten() {
          return consumed ? rowsWritten : 0;
        },
      };
    },
  };

  return {
    sql,
    calls,
    setRows(query: string, rows: unknown[]) {
      rowsByQuery.set(query, rows);
    },
    setRowsWritten(value: number) {
      rowsWritten = value;
    },
  };
}

describe("SessionAttachmentRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: SessionAttachmentRepository;

  beforeEach(() => {
    mock = createMockSql();
    repository = new SessionAttachmentRepository(mock.sql);
  });

  it("creates a session attachment record", () => {
    repository.create({
      id: "up-1",
      mimeType: "image/png",
      sizeBytes: 1024,
      objectKey: "sessions/session-1/attachments/up-1",
      createdAt: 1000,
    });

    expect(mock.calls[0].query).toContain("INSERT INTO attachments");
    expect(mock.calls[0].params).toEqual([
      "up-1",
      "image/png",
      1024,
      "sessions/session-1/attachments/up-1",
      1000,
    ]);
  });

  it("returns attachment totals excluding cleanup claims", () => {
    const query = `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_bytes
       FROM attachments WHERE cleanup_claimed_at IS NULL`;
    mock.setRows(query, [{ count: 2, total_bytes: 3072 }]);

    expect(repository.getTotals()).toEqual({ count: 2, totalBytes: 3072 });
  });

  it("finds only unreferenced, unclaimed attachments", () => {
    repository.getUnreferenced(["up-1", "up-2"]);

    expect(mock.calls[0].query).toContain("message_id IS NULL");
    expect(mock.calls[0].query).toContain("cleanup_claimed_at IS NULL");
    expect(mock.calls[0].params).toEqual(["up-1", "up-2"]);
  });

  it("claims every attachment for a message", () => {
    mock.setRowsWritten(2);

    repository.claimForMessage("msg-1", ["up-1", "up-2"]);

    expect(mock.calls[0].query).toContain("UPDATE attachments SET message_id");
    expect(mock.calls[0].params).toEqual(["msg-1", "up-1", "up-2"]);
  });

  it("rejects a partial attachment claim", () => {
    mock.setRowsWritten(1);

    expect(() => repository.claimForMessage("msg-1", ["up-1", "up-2"])).toThrow(
      AttachmentClaimConflictError
    );
  });

  it("claims stale attachment records with a cleanup lease", () => {
    const query = `SELECT * FROM attachments
       WHERE message_id IS NULL AND created_at < ?
         AND (cleanup_claimed_at IS NULL OR cleanup_claimed_at < ?)`;
    mock.setRows(query, [
      {
        id: "up-1",
        mime_type: "image/png",
        size_bytes: 100,
        object_key: "sessions/session-1/attachments/up-1",
        message_id: null,
        cleanup_claimed_at: null,
        created_at: 1,
      },
    ]);

    const claimed = repository.claimStale(100, 200, 150);

    expect(claimed[0].cleanup_claimed_at).toBe(200);
    expect(mock.calls[1].params).toEqual([200, "up-1"]);
  });

  it("acknowledges only the matching cleanup lease", () => {
    repository.acknowledgeCleanup(["up-1", "up-2"], 1234);

    expect(mock.calls[0].query).toContain("cleanup_claimed_at = ?");
    expect(mock.calls[0].query).toContain("message_id IS NULL");
    expect(mock.calls[0].params).toEqual(["up-1", "up-2", 1234]);
  });

  it("releases only the matching cleanup lease", () => {
    repository.releaseCleanupClaims(["up-1", "up-2"], 1234);

    expect(mock.calls[0].query).toContain("cleanup_claimed_at = ?");
    expect(mock.calls[0].query).toContain("message_id IS NULL");
    expect(mock.calls[0].params).toEqual(["up-1", "up-2", 1234]);
  });
});
