import { describe, expect, it, vi } from "vitest";
import {
  MAX_AUTOMATION_INVOCATION_LIST_LIMIT,
  MAX_AUTOMATION_REPOSITORIES,
} from "@open-inspect/shared/types/automations";
import { emptyStatement, TEST_SESSION_ROW } from "../router.test-support";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import { SessionIndexStore } from "./session-index";
import type { SqlDatabase, SqlStatement } from "./sql-database";

function database(rows: ReadonlyMap<string, unknown> = new Map()) {
  const bindings: unknown[][] = [];
  const prepare = vi.fn((sql: string) => {
    let ids: unknown[] = [];
    const statement: SqlStatement = {
      ...emptyStatement(),
      bind(...values) {
        expect(values.length).toBeLessThanOrEqual(MAX_D1_QUERY_PARAMETERS);
        expect(sql.match(/\?/g)).toHaveLength(values.length);
        ids = values;
        bindings.push(values);
        return statement;
      },
      all: async <T>() => ({
        results: ids.flatMap((id) => (rows.has(String(id)) ? [rows.get(String(id)) as T] : [])),
        meta: { changes: 0 },
      }),
    };
    return statement;
  });
  const db: SqlDatabase = { prepare, batch: vi.fn() };
  return { db, prepare, bindings };
}

describe("SessionIndexStore.getByIds", () => {
  it("deduplicates a full run page and chunks reads within the D1 parameter limit", async () => {
    const ids = Array.from(
      { length: MAX_AUTOMATION_INVOCATION_LIST_LIMIT * MAX_AUTOMATION_REPOSITORIES },
      (_, i) => `session-${i}`
    );
    const rows = new Map(
      ids.slice(0, -1).map((id) => [
        id,
        {
          ...TEST_SESSION_ROW,
          id,
          user_id: "session-owner",
          owner_team_id: "team_alpha",
          visibility: "private",
        },
      ])
    );
    const { db, prepare, bindings } = database(rows);

    const sessions = await new SessionIndexStore(db).getByIds([...ids, ...ids]);

    expect(prepare).toHaveBeenCalledTimes(Math.ceil(ids.length / MAX_D1_QUERY_PARAMETERS));
    expect(bindings.flat()).toEqual(ids);
    expect(sessions.size).toBe(ids.length - 1);
    expect(sessions.has(ids.at(-1)!)).toBe(false);
    expect(sessions.get(ids[0])).toMatchObject({
      id: ids[0],
      userId: "session-owner",
      ownerTeamId: "team_alpha",
      visibility: "private",
    });
  });

  it("does not query for an empty set of IDs", async () => {
    const { db, prepare } = database();

    expect(await new SessionIndexStore(db).getByIds([])).toEqual(new Map());
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects malformed persisted rows through the canonical session-row parser", async () => {
    const { db } = database(
      new Map([["session-1", { ...TEST_SESSION_ROW, visibility: "invalid" }]])
    );

    await expect(new SessionIndexStore(db).getByIds(["session-1"])).rejects.toThrow(
      "Malformed persisted session index row"
    );
  });
});
