import { describe, expect, it, vi } from "vitest";
import { emptyStatement } from "../router.test-support";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";
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
        scope: "all",
      })
    ).rejects.toThrow("Invalid session run row");
  });

  it("rejects malformed single-run rows", async () => {
    await expect(new SessionRunStore(database).get("root")).rejects.toThrow(
      "Invalid session run row"
    );
  });
});

it("prepares root-windowed scoped runs and decodes a nullable title", () => {
  let query = "";
  let binds: unknown[] = [];
  const statement: SqlStatement = {
    ...emptyStatement(),
    bind: (...values) => {
      binds = values;
      return statement;
    },
  };
  const store = new SessionRunStore({
    prepare: (sql) => {
      query = sql;
      return statement;
    },
    batch: async () => [],
  });
  store.prepareList({ startAt: 10, endAt: 20, limit: 2, orderBy: "cost", scope: "human" });
  expect(query).toContain("root.created_at >= ? AND root.created_at < ?");
  expect(query).toContain("root.spawn_source IN (?, ?, ?, ?)");
  expect(query).toContain("root.title");
  expect(binds).toEqual([10, 20, "user", "slack-bot", "linear-bot", "github-bot", 2]);
  const row = {
    root_session_id: "root",
    title: null,
    session_count: 1,
    max_spawn_depth: 0,
    total_cost: 2,
    total_prs: 0,
    input_tokens: 1,
    output_tokens: 2,
    reasoning_tokens: 0,
    cache_read_tokens: 3,
    cache_write_tokens: 4,
    created_at: 10,
    updated_at: 11,
    user_id: null,
    scm_login: null,
    spawn_source: "user",
    automation_id: null,
    repo_owner: null,
    repo_name: null,
  };
  const result: SqlResult = { meta: { changes: 0 }, results: [row] };
  expect(store.decodeList(result)).toEqual([
    expect.objectContaining({ rootSessionId: "root", title: null }),
  ]);
  expect(() => store.decodeList({ ...result, results: [{ ...row, title: 9 }] })).toThrow(
    "Invalid session run row"
  );
});
