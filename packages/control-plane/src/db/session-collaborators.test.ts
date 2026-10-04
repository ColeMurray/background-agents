import { describe, expect, it, vi } from "vitest";
import { emptyStatement } from "../router.test-support";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import { SessionCollaboratorStore } from "./session-collaborators";
import type { SqlDatabase, SqlStatement } from "./sql-database";

describe("SessionCollaboratorStore.listForSessions default bulk reads", () => {
  it("chunks more than 100 IDs within the parameter limit and keeps all collaborator rows", async () => {
    const ids = Array.from(
      { length: MAX_D1_QUERY_PARAMETERS * 2 + 3 },
      (_, index) => `session-${index}`
    );
    const collaborators = new Map(
      ids.slice(0, -1).map((id) => [id, [`${id}-owner`, `${id}-collaborator`]])
    );
    const bindings: unknown[][] = [];
    const prepare = vi.fn((sql: string): SqlStatement => {
      expect(sql).toContain("WHERE session_id IN (");
      expect(sql).not.toContain("EXISTS");
      let boundIds: unknown[] = [];
      const statement: SqlStatement = {
        ...emptyStatement(),
        bind(...values) {
          expect(values.length).toBeLessThanOrEqual(MAX_D1_QUERY_PARAMETERS);
          expect(sql.match(/\?/g)).toHaveLength(values.length);
          bindings.push(values);
          boundIds = values;
          return statement;
        },
        all: async <T>() => ({
          results: boundIds.flatMap((id) =>
            (collaborators.get(String(id)) ?? []).map(
              (user_id) => ({ session_id: id, user_id }) as T
            )
          ),
          meta: { changes: 0 },
        }),
      };
      return statement;
    });
    const db: SqlDatabase = { prepare, batch: async () => [] };

    const actual = await new SessionCollaboratorStore(db).listForSessions(ids);

    expect(actual).toEqual(collaborators);
    expect(actual.has(ids.at(-1)!)).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(Math.ceil(ids.length / MAX_D1_QUERY_PARAMETERS));
    expect(bindings.flat()).toEqual(ids);
  });

  it("does not issue an empty default bulk query", async () => {
    const prepare = vi.fn(() => emptyStatement());
    const db: SqlDatabase = { prepare, batch: async () => [] };

    expect(await new SessionCollaboratorStore(db).listForSessions([])).toEqual(new Map());
    expect(prepare).not.toHaveBeenCalled();
  });
});
