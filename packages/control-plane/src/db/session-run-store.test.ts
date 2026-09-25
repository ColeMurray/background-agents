import { describe, expect, it, vi } from "vitest";
import { emptyStatement } from "../router.test-support";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { SessionRunStore } from "./session-run-store";

describe("SessionRunStore row validation", () => {
  const malformedRow = { root_session_id: "root", session_count: "not a count" };
  const statement: SqlStatement = {
    ...emptyStatement(),
    bind: () => statement,
    all: vi.fn().mockResolvedValue({ results: [malformedRow], meta: { changes: 0 } }),
    first: vi.fn().mockResolvedValue(malformedRow),
  };
  const database: SqlDatabase = {
    prepare: () => statement,
    batch: async () => [],
  };

  it("rejects malformed list rows rather than returning unchecked data", async () => {
    await expect(
      new SessionRunStore(database).list({
        startAt: 0,
        endAt: 1,
        limit: 1,
        orderBy: "cost",
      })
    ).rejects.toThrow("Invalid session run row");
  });

  it("rejects malformed single-run rows", async () => {
    await expect(new SessionRunStore(database).get("root")).rejects.toThrow(
      "Invalid session run row"
    );
  });
});
