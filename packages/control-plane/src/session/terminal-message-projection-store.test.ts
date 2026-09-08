import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initSchema } from "./schema";
import type { SqlResult, SqlStorage } from "./sql-storage";
import { PersistedTerminalMessageProjectionStore } from "./terminal-message-projection-store";

function createDatabaseSql(db: DatabaseSync): SqlStorage {
  return {
    exec(query: string, ...params: unknown[]): SqlResult {
      const sqliteParams = params as SQLInputValue[];
      if (/^\s*(?:PRAGMA|SELECT)\b/i.test(query)) {
        const rows = db.prepare(query).all(...sqliteParams);
        return { toArray: () => rows, one: () => rows[0] ?? null };
      }
      if (params.length > 0) db.prepare(query).run(...sqliteParams);
      else db.exec(query);
      return { toArray: () => [], one: () => null };
    },
  };
}

function createStore() {
  const sql = createDatabaseSql(new DatabaseSync(":memory:"));
  initSchema(sql);
  return new PersistedTerminalMessageProjectionStore(sql);
}

const older = {
  messageId: "message-1",
  messageCreatedAt: 1_000,
  terminalMessageCompletedAt: 2_000,
  attempts: 0,
  nextAttemptAt: 5_000,
};
const newer = {
  messageId: "message-2",
  messageCreatedAt: 3_000,
  terminalMessageCompletedAt: 4_000,
  attempts: 0,
  nextAttemptAt: 6_000,
};

describe("PersistedTerminalMessageProjectionStore", () => {
  it("starts empty and round-trips a pending projection", () => {
    const store = createStore();
    expect(store.pending()).toBeNull();

    store.setPending(older);

    expect(store.pending()).toEqual(older);
  });

  it("keeps only the newest message and its retry metadata", () => {
    const store = createStore();
    store.setPending({ ...newer, attempts: 3, nextAttemptAt: 9_000 });
    store.setPending(older);
    expect(store.pending()).toEqual({ ...newer, attempts: 3, nextAttemptAt: 9_000 });

    store.setPending(newer);
    expect(store.pending()).toEqual({ ...newer, attempts: 3, nextAttemptAt: 9_000 });
  });

  it("records a failed attempt only for the message that was attempted", () => {
    const store = createStore();
    store.setPending(older);

    store.recordFailedAttempt({ ...older, attempts: 2, nextAttemptAt: 20_000 });
    expect(store.pending()).toEqual({ ...older, attempts: 2, nextAttemptAt: 20_000 });

    store.setPending(newer);
    store.recordFailedAttempt({ ...older, attempts: 3, nextAttemptAt: 40_000 });
    expect(store.pending()).toEqual(newer);
  });

  it("clears through a landed message but not past a newer one", () => {
    const store = createStore();
    store.setPending(newer);

    store.clearThrough(older);
    expect(store.pending()).toEqual(newer);

    store.clearThrough(newer);
    expect(store.pending()).toBeNull();
  });
});
