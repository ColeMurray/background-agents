import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { SessionArchiveProjectionStore } from "./session-archive-projection-store";

let db: NodeSqlDatabase;
let store: SessionArchiveProjectionStore;
beforeEach(async () => {
  db = createNodeSqlDatabase(new DatabaseSync(":memory:"));
  await db
    .prepare("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, updated_at INTEGER)")
    .run();
  await db.prepare("INSERT INTO sessions VALUES ('one', 'completed', 500)").run();
  store = new SessionArchiveProjectionStore(db);
});
afterEach(() => db.close());

it("repairs the observed state without changing the activity timestamp", async () => {
  const observed = await store.read("one");
  expect(observed).toEqual({ status: "completed", updatedAt: 500 });
  expect(await store.archiveIfUnchanged("one", observed!)).toBe(true);
  expect(await store.read("one")).toEqual({ status: "archived", updatedAt: 500 });
});

it.each([
  "UPDATE sessions SET status = 'active', updated_at = 501 WHERE id = 'one'",
  "UPDATE sessions SET updated_at = 501 WHERE id = 'one'",
  "UPDATE sessions SET status = 'cancelled' WHERE id = 'one'",
  "DELETE FROM sessions WHERE id = 'one'",
])("rejects an intervening mutation: %s", async (mutation) => {
  const observed = await store.read("one");
  await db.prepare(mutation).run();
  const newer = await store.read("one");
  expect(await store.archiveIfUnchanged("one", observed!)).toBe(false);
  expect(await store.read("one")).toEqual(newer);
});
