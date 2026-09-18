import { describe, expect, it, vi } from "vitest";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
import {
  SessionCreationClaimStore,
  SessionCreationRequestConflictError,
} from "./session-creation-claims";

function result<T>(results: T[], changes = 0): SqlResult<T> {
  return { results, meta: { changes } };
}

function database(batchResults: SqlResult[]): {
  db: SqlDatabase;
  statements: Array<{ query: string; values: unknown[] }>;
} {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const prepare = vi.fn((query: string): SqlStatement => {
    const record = { query, values: [] as unknown[] };
    statements.push(record);
    const statement: SqlStatement = {
      bind: (...values) => {
        record.values = values;
        return statement;
      },
      first: vi.fn(),
      run: vi.fn(async () => result([], 1)),
      all: vi.fn(),
    };
    return statement;
  });
  return {
    db: {
      prepare,
      batch: vi.fn(async () => batchResults) as SqlDatabase["batch"],
    },
    statements,
  };
}

describe("SessionCreationClaimStore", () => {
  it("atomically inserts and reads a new claim", async () => {
    const { db, statements } = database([
      result([], 1),
      result([{ request_fingerprint: "fingerprint", session_id: "session-1", status: "claimed" }]),
    ]);

    await expect(
      new SessionCreationClaimStore(db).claim({
        userScope: "user-1",
        clientRequestId: "request-1",
        requestFingerprint: "fingerprint",
        sessionId: "session-1",
        now: 1000,
      })
    ).resolves.toEqual({ sessionId: "session-1", status: "claimed" });
    expect(statements[0].query).toContain("INSERT OR IGNORE");
    expect(statements[0].values).toEqual([
      "user-1",
      "request-1",
      "fingerprint",
      "session-1",
      1000,
      1000,
    ]);
  });

  it("returns the allocated session for a matching retry", async () => {
    const { db } = database([
      result([], 0),
      result([{ request_fingerprint: "fingerprint", session_id: "session-1", status: "created" }]),
    ]);

    await expect(
      new SessionCreationClaimStore(db).claim({
        userScope: "user-1",
        clientRequestId: "request-1",
        requestFingerprint: "fingerprint",
        sessionId: "unused-session",
        now: 2000,
      })
    ).resolves.toEqual({ sessionId: "session-1", status: "created" });
  });

  it("rejects reuse with a changed fingerprint", async () => {
    const { db } = database([
      result([], 0),
      result([{ request_fingerprint: "original", session_id: "session-1", status: "claimed" }]),
    ]);

    await expect(
      new SessionCreationClaimStore(db).claim({
        userScope: "user-1",
        clientRequestId: "request-1",
        requestFingerprint: "changed",
        sessionId: "unused-session",
        now: 2000,
      })
    ).rejects.toBeInstanceOf(SessionCreationRequestConflictError);
  });

  it("marks only the allocated claim as created", async () => {
    const { db, statements } = database([result([], 1), result([], 1)]);

    await new SessionCreationClaimStore(db).markCreated("user-1", "request-1", "session-1", 3000);

    expect(statements[0].query).toContain("SET status = 'created'");
    expect(statements[0].values).toEqual([3000, "user-1", "request-1", "session-1"]);
    expect(statements[1].query).toContain("status_revision = 0");
    expect(statements[1].values).toEqual([3000, "session-1"]);
  });

  it("fences failure projection on an uncompleted claim", async () => {
    const { db, statements } = database([]);

    await new SessionCreationClaimStore(db).markSessionFailedIfClaimed(
      "user-1",
      "request-1",
      "session-1",
      5000
    );

    expect(statements[0].query).toContain("status = 'claimed'");
    expect(statements[0].values).toEqual([5000, "session-1", "user-1", "request-1", "session-1"]);
  });
});
